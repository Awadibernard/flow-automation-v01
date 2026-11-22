/**
 * tests/start-flow-simulate.js
 * Tests SIMULÉS du parcours "Démarrer" : vérification de la chaîne, validation
 * des prompts, création/démarrage de la file et confirmation réelle.
 *
 * On simule un service worker (background) et un content script en mémoire,
 * avec différents scénarios de panne, pour vérifier que l'UI ne prétend jamais
 * que le traitement a commencé s'il n'a pas réellement démarré.
 *
 * Exécution : node tests/start-flow-simulate.js
 */

'use strict';

const statusLib = require('../status.js');

const PROJECT_URL = 'https://flow.google.com/project/207c69fe-016e-420d-bdce-6af7423c8427';

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

// --- Simulation du monde "extension" ---------------------------------------
// cfg permet de régler chaque panne.
function makeWorld(cfg) {
  const c = Object.assign({
    apiAvailable: true,
    tab: { id: 7, url: PROJECT_URL, status: 'complete', active: true },
    flowTabs: 1,
    contentPresent: true,
    injectError: null,
    pageState: {
      url: PROJECT_URL, isFlowPage: true, isInProject: true, readyState: 'complete',
      hasAppRoot: true, hasPrompt: true, hasSubmit: true, tiles: 1
    },
    pageStateResponds: true,
    receiveQueue: true,      // le content script accepte QUEUE_CREATE/START
    queueActuallyRuns: true, // la file tourne vraiment après START
    queryError: null
  }, cfg || {});

  const world = {
    created: null,
    started: false,
    queueState: { items: [], isRunning: false, isPaused: false, currentIndex: -1 }
  };

  world.bgSend = async (message) => {
    if (!c.apiAvailable) return { ok: false, error: 'API navigateur indisponible' };
    switch (message.type) {
      case 'GET_ACTIVE_FLOW_TAB':
        if (c.queryError) return { ok: false, error: c.queryError };
        if (!c.tab) return { ok: false, error: 'Aucun onglet' };
        return {
          ok: true, tabId: c.tab.id, url: c.tab.url, status: c.tab.status,
          isFlow: c.flowTabs > 0, flowTabs: c.flowTabs
        };
      case 'ENSURE_CONTENT':
        return { ok: true, tabId: c.tab && c.tab.id, present: c.contentPresent, injected: false, injectAttempted: true, injectError: c.injectError };
      case 'SEND_TO_CONTENT':
        return world.contentReceive(message.payload);
      default:
        return { ok: false, error: 'inconnu' };
    }
  };

  world.contentReceive = async (payload) => {
    switch (payload.type) {
      case 'GET_PAGE_STATE':
        if (!c.contentPresent) return { ok: false, error: 'Receiving end does not exist' };
        if (!c.pageStateResponds) return { ok: false, error: 'The message port closed before a response was received' };
        return { ok: true, value: c.pageState };
      case 'QUEUE_CREATE':
        if (!c.contentPresent || !c.receiveQueue) return { ok: false, error: 'Receiving end does not exist' };
        world.created = payload.prompts.slice();
        world.queueState.items = payload.prompts.map((p, i) => ({ id: 'p-1-' + i, prompt: p, status: 'IDLE' }));
        return { ok: true };
      case 'QUEUE_START':
        if (!c.receiveQueue) return { ok: false, error: 'Receiving end does not exist' };
        world.started = true;
        if (c.queueActuallyRuns) world.queueState.isRunning = true;
        return { ok: true };
      case 'QUEUE_GET':
        return { ok: true, value: world.queueState };
      default:
        return { ok: false, error: 'inconnu' };
    }
  };

  return { cfg: c, world };
}

// --- Réplique de la logique de popup.js (onStart + checkFlowPage) ----------
// (isolée ici pour être testable sans DOM ; doit rester synchronisée.)

async function probeContent(bgSend, cfg) {
  const ens = await bgSend({ type: 'ENSURE_CONTENT' });
  if (ens && ens.ok) {
    return {
      present: !!ens.present, injected: !!ens.injected,
      injectAttempted: !!ens.injectAttempted, injectError: ens.injectError || null
    };
  }
  return { present: !!cfg.contentPresent, injected: false, injectAttempted: false, injectError: (ens && ens.error) || null };
}

async function checkFlowPage(bgSend, cfg) {
  const facts = {
    apiAvailable: cfg.apiAvailable, tab: null, contentPresent: false,
    injectAttempted: false, injectError: null, pageState: null, error: null, errorStage: null
  };
  if (!cfg.apiAvailable) return { ok: false, status: statusLib.derive({ apiAvailable: false }) };

  const tabResp = await bgSend({ type: 'GET_ACTIVE_FLOW_TAB' });
  if (!tabResp || !tabResp.ok) {
    facts.error = (tabResp && tabResp.error) || 'no response';
    facts.errorStage = 'QUERY_TABS';
    return { ok: false, status: statusLib.derive(facts) };
  }
  facts.tab = { id: tabResp.tabId, url: tabResp.url, status: tabResp.status };
  if (!tabResp.isFlow) return { ok: false, status: statusLib.derive({ ...facts, contentPresent: false }) };

  // Présence réelle du content script (PING via ENSURE_CONTENT).
  const probe = await probeContent(bgSend, cfg);
  facts.contentPresent = probe.present;
  facts.injectAttempted = probe.injectAttempted;
  facts.injectError = probe.injectError;
  if (!probe.present) {
    facts.error = probe.injectError || null;
    facts.errorStage = 'SEND';
    return { ok: false, status: statusLib.derive(facts) };
  }

  const ps = await bgSend({ type: 'SEND_TO_CONTENT', payload: { type: 'GET_PAGE_STATE' } });
  if (!ps || !ps.ok || !ps.value) {
    facts.pageState = null;
    facts.error = (ps && ps.error) || 'no response';
    facts.errorStage = 'PAGE_STATE';
    return { ok: false, status: statusLib.derive(facts) };
  }
  facts.pageState = ps.value;
  const st = statusLib.derive(facts);
  return { ok: st.code === 'READY', status: st };
}

async function onStart(bgSend, cfg, rawText) {
  const prompts = String(rawText || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (prompts.length === 0) {
    return { started: false, reason: 'Aucun prompt valide', status: null };
  }
  const check = await checkFlowPage(bgSend, cfg);
  if (!check.ok) {
    return { started: false, reason: 'Not ready: ' + check.status.code, status: check.status };
  }
  const created = await bgSend({ type: 'SEND_TO_CONTENT', payload: { type: 'QUEUE_CREATE', prompts } });
  if (!created || !created.ok) {
    return { started: false, reason: 'Création impossible', status: check.status };
  }
  const started = await bgSend({ type: 'SEND_TO_CONTENT', payload: { type: 'QUEUE_START' } });
  if (!started || !started.ok) {
    return { started: false, reason: 'Démarrage impossible', status: check.status };
  }
  const got = await bgSend({ type: 'SEND_TO_CONTENT', payload: { type: 'QUEUE_GET' } });
  const state = got && got.value;
  if (!state || !state.items || !state.isRunning) {
    return { started: false, reason: 'La file ne démarre pas', status: check.status };
  }
  return { started: true, reason: 'ok', status: check.status, queue: state };
}

(async function run() {
  console.log('\n=== Tests simulés : parcours Démarrer ===\n');

  console.log('--- Aucun prompt ---');
  {
    const { cfg, world } = makeWorld();
    const r = await onStart(world.bgSend, cfg, '   \n\n  ');
    assert('démarrage refusé', r.started === false);
    assert('raison = aucun prompt', r.reason === 'Aucun prompt valide', r.reason);
    assert('aucune file créée', world.created === null);
  }

  console.log('\n--- Démarrage valide (1 prompt, page prête) ---');
  {
    const { cfg, world } = makeWorld();
    const r = await onStart(world.bgSend, cfg, 'A cat in space\n');
    assert('démarrage accepté', r.started === true, r.reason);
    assert('file créée avec 1 prompt', world.created && world.created.length === 1);
    assert('file réellement en cours', r.queue && r.queue.isRunning === true);
  }

  console.log('\n--- Démarrage multi-prompts (lignes vides ignorées) ---');
  {
    const { cfg, world } = makeWorld();
    const r = await onStart(world.bgSend, cfg, 'one\n\n  \ntwo\nthree\n');
    assert('3 prompts retenus', world.created.length === 3, JSON.stringify(world.created));
    assert('démarrage accepté', r.started === true);
  }

  console.log('\n--- Refus si page non prête (champ absent) ---');
  {
    const { cfg, world } = makeWorld({ pageState: { url: PROJECT_URL, isFlowPage: true, isInProject: true, readyState: 'complete', hasAppRoot: true, hasPrompt: false, hasSubmit: false, tiles: 0 } });
    const r = await onStart(world.bgSend, cfg, 'hello');
    assert('démarrage refusé', r.started === false);
    assert('raison = PROJECT_NO_PROMPT', r.status.code === 'PROJECT_NO_PROMPT', r.status.code);
    assert('aucune création de file', world.created === null);
  }

  console.log('\n--- Refus si content script absent ---');
  {
    const { cfg, world } = makeWorld({ contentPresent: false, injectError: 'Cannot access contents of the url' });
    const r = await onStart(world.bgSend, cfg, 'hello');
    assert('démarrage refusé', r.started === false);
    assert('raison = CONTENT_ABSENT', r.status.code === 'CONTENT_ABSENT', r.status.code);
    assert('aucune file créée', world.created === null);
  }

  console.log('\n--- Refus si message sans réponse ---');
  {
    const { cfg, world } = makeWorld({ pageStateResponds: false });
    const r = await onStart(world.bgSend, cfg, 'hello');
    assert('démarrage refusé', r.started === false);
    assert('raison = CONTENT_NO_RESPONSE', r.status.code === 'CONTENT_NO_RESPONSE', r.status.code);
  }

  console.log('\n--- Refus si API indisponible ---');
  {
    const { cfg, world } = makeWorld({ apiAvailable: false });
    const r = await onStart(world.bgSend, cfg, 'hello');
    assert('démarrage refusé', r.started === false);
    assert('raison = API_UNAVAILABLE', r.status.code === 'API_UNAVAILABLE', r.status.code);
  }

  console.log('\n--- Refus si aucun onglet Flow ---');
  {
    const { cfg, world } = makeWorld({ tab: { id: 3, url: 'https://example.com/', status: 'complete', active: true }, flowTabs: 0 });
    const r = await onStart(world.bgSend, cfg, 'hello');
    assert('démarrage refusé', r.started === false);
    assert('raison = NOT_FLOW', r.status.code === 'NOT_FLOW', r.status.code);
  }

  console.log('\n--- Message QUEUE_START accepté mais file inactive (ne pas mentir) ---');
  {
    const { cfg, world } = makeWorld({ queueActuallyRuns: false });
    const r = await onStart(world.bgSend, cfg, 'hello');
    assert('non signalé comme démarré', r.started === false);
    assert('raison = file inactive', r.reason === 'La file ne démarre pas', r.reason);
  }

  console.log('\n--- Erreur de communication à la création de file ---');
  {
    const { cfg, world } = makeWorld({ receiveQueue: false });
    const r = await onStart(world.bgSend, cfg, 'hello');
    assert('démarrage refusé', r.started === false);
    assert('raison = création impossible', r.reason === 'Création impossible', r.reason);
  }

  console.log('\n--- Erreur tabs.query ---');
  {
    const { cfg, world } = makeWorld({ queryError: 'tabs.query forbidden' });
    const r = await onStart(world.bgSend, cfg, 'hello');
    assert('démarrage refusé', r.started === false);
    assert('raison = TAB_QUERY_ERROR', r.status.code === 'TAB_QUERY_ERROR', r.status.code);
  }

  console.log('\n--- Résultat ---');
  console.log('Passed: ' + passed + ' / Failed: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
})();

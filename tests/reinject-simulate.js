/**
 * tests/reinject-simulate.js
 * Tests SIMULÉS de la RÉINJECTION du content script.
 *
 * Contexte : le service worker réinjecte le content script quand il ne répond
 * pas (PING échoué). Ce fichier vérifie que cette réinjection ne casse rien :
 *
 *  1. Première évaluation : les modules s'enregistrent normalement.
 *  2. Deuxième évaluation (réinjection alors que le script tourne) :
 *     - queue-manager NE DOIT PAS écraser la file existante ;
 *     - content.js NE DOIT PAS réenregistrer un second écouteur ;
 *     - une file en cours ne doit pas être perdue.
 *
 * Exécution : node tests/reinject-simulate.js
 */

'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

// --- Monde simulé minimal : window + chrome.storage en mémoire --------------

function makeWorld() {
  const store = {};
  const listeners = [];

  const chromeApi = {
    runtime: {
      sendMessage: () => Promise.resolve({ ok: true }),
      onMessage: { addListener: (fn) => listeners.push(fn) }
    },
    storage: {
      local: {
        get: (k) => Promise.resolve(k in store ? { [k]: store[k] } : {}),
        set: (o) => { Object.assign(store, o); return Promise.resolve(); },
        remove: (k) => { delete store[k]; return Promise.resolve(); }
      },
      onChanged: { addListener() {}, removeListener() {} }
    }
  };

  const win = {
    FlowAutomation: {},
    __timers: []
  };
  const doc = {
    readyState: 'complete',
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const loc = { hostname: 'flow.google.com', pathname: '/project/x', href: 'https://flow.google.com/project/x' };

  return { store, listeners, chromeApi, win, doc, loc };
}

/**
 * Évalue un fichier dans le contexte simulé, comme le ferait le navigateur
 * (chaque fichier est un script classique ré-évaluable, pas un module caché).
 */
function evalFile(world, file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const fn = new Function('window', 'document', 'location', 'chrome', 'browser',
    'structuredClone', 'setInterval', 'fetch', 'console', code);
  fn(world.win, world.doc, world.loc, world.chromeApi, undefined,
     (v) => JSON.parse(JSON.stringify(v)), () => 0,
     () => Promise.reject(new Error('no network')), console);
}

function loadStack(world) {
  const files = ['status.js', 'storage-manager.js', 'flow-dom.js',
    'generation-manager.js', 'download-manager.js', 'queue-manager.js'];
  for (const f of files) evalFile(world, f);
  // content.js lance une init asynchrone : on l'évalue en dernier.
  evalFile(world, 'content.js');
}

(async function run() {
  console.log('\n=== Tests simulés : réinjection du content script ===\n');

  // --- 1. Première évaluation ---
  console.log('--- 1. Première évaluation ---');
  const w = makeWorld();
  loadStack(w);
  await new Promise((r) => setTimeout(r, 60));

  assert('queue exposée', !!w.win.FlowAutomation.queue);
  assert('marqueur posé', w.win.__FLOW_AUTOMATION_LOADED__ === '0.1.5', String(w.win.__FLOW_AUTOMATION_LOADED__));
  assert('un seul écouteur de messages', w.listeners.length === 1, 'listeners=' + w.listeners.length);

  const queueRef = w.win.FlowAutomation.queue;
  queueRef.create(['prompt A', 'prompt B']);
  await new Promise((r) => setTimeout(r, 30));
  const before = queueRef.getState();
  assert('file créée avec 2 prompts', before.items.length === 2, 'n=' + before.items.length);

  // Met la file dans un état "génération en cours" RÉEL (via l'API publique) :
  // le pipeline ne se termine jamais, ce qui fige l'item en GENERATING.
  queueRef.setPipeline(() => new Promise(() => {}));
  queueRef.start();
  await new Promise((r) => setTimeout(r, 80));

  const running = queueRef.getState();
  assert('état "en cours" atteint', running.isRunning === true && running.currentIndex === 0,
    'isRunning=' + running.isRunning + ' idx=' + running.currentIndex);
  // Le pipeline bloque volontairement : l'item reste dans un état "en cours".
  const IN_PROGRESS = ['PREPARING', 'SUBMITTING', 'GENERATING', 'DETECTING_RESULT', 'DOWNLOADING'];
  assert('prompt 0 dans un état en cours', IN_PROGRESS.indexOf(running.items[0].status) !== -1,
    running.items[0].status);

  // --- 2. Réinjection alors que le script tourne déjà ---
  console.log('\n--- 2. Réinjection (2e évaluation) ---');
  loadStack(w);
  await new Promise((r) => setTimeout(r, 60));

  assert('queue-manager NE réinitialise PAS l\'objet queue',
    w.win.FlowAutomation.queue === queueRef, 'objet queue remplacé');

  const after = w.win.FlowAutomation.queue.getState();
  assert('la file survit à la réinjection', after.items.length === 2, 'n=' + after.items.length);
  assert('le prompt en cours est préservé',
    IN_PROGRESS.indexOf(after.items[0].status) !== -1, after.items[0].status);
  assert('isRunning préservé', after.isRunning === true);
  assert('currentIndex préservé', after.currentIndex === 0, String(after.currentIndex));

  assert('PAS de second écouteur de messages', w.listeners.length === 1, 'listeners=' + w.listeners.length);

  // --- 3. L'écouteur unique répond toujours correctement ---
  console.log('\n--- 3. L\'écouteur unique fonctionne après réinjection ---');
  let response = null;
  const handled = w.listeners[0]({ type: 'PING' }, {}, (r) => { response = r; });
  void handled;
  assert('PING répond pong', response && response.pong === true, JSON.stringify(response));

  response = null;
  w.listeners[0]({ type: 'GET_INJECTED' }, {}, (r) => { response = r; });
  assert('GET_INJECTED répond injected=true', response && response.injected === true, JSON.stringify(response));

  response = null;
  w.listeners[0]({ type: 'GET_PAGE_STATE' }, {}, (r) => { response = r; });
  assert('GET_PAGE_STATE répond ok', response && response.ok === true, JSON.stringify(response));

  response = null;
  w.listeners[0]({ type: 'QUEUE_GET' }, {}, (r) => { response = r; });
  assert('QUEUE_GET renvoie encore les 2 prompts',
    response && response.value && response.value.items.length === 2,
    JSON.stringify(response && response.value && response.value.items.length));

  console.log('\n--- Résultat ---');
  console.log('Passed: ' + passed + ' / Failed: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Erreur de test:', e);
  process.exit(2);
});

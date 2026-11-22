/**
 * popup.js — Flow Automation V0.1.1
 *
 * Chaîne réelle : Popup -> Background -> Onglet actif -> Content script -> DOM.
 * Aucun échec silencieux : chaque étape est journalisée et affichée.
 */

'use strict';

// --- Couche d'adaptation : `chrome` en priorité (Chromium/Quetta) -----------
const api = (typeof chrome !== 'undefined' && chrome.runtime)
  ? chrome
  : (typeof browser !== 'undefined' ? browser : null);

const statusLib = (typeof FlowAutomation !== 'undefined' && FlowAutomation.status) || null;

const els = {
  status: document.getElementById('page-status'),
  detail: document.getElementById('status-detail'),
  recheck: document.getElementById('btn-recheck'),
  diagnose: document.getElementById('btn-diagnose'),
  prompts: document.getElementById('prompts'),
  start: document.getElementById('btn-start'),
  pause: document.getElementById('btn-pause'),
  resume: document.getElementById('btn-resume'),
  cancel: document.getElementById('btn-cancel'),
  progress: document.getElementById('queue-progress'),
  current: document.getElementById('current-prompt'),
  items: document.getElementById('queue-items'),
  log: document.getElementById('log-area'),
  diagCard: document.getElementById('diag-card'),
  diagReport: document.getElementById('diag-report'),
  copyDiag: document.getElementById('btn-copy-diag'),
  setModel: document.getElementById('set-model'),
  setRatio: document.getElementById('set-ratio'),
  setCount: document.getElementById('set-count'),
  setFolder: document.getElementById('set-folder')
};

let flowTabId = null;
let queueSnapshot = null;
let lastState = null; // dernier objet status { code, label, detail, level }

// --- Utilitaires ------------------------------------------------------------

function setStatus(text, level, detail) {
  els.status.textContent = text;
  els.status.className = 'status ' + (level || '');
  els.detail.textContent = detail || '';
}

function applyState(st) {
  if (!st) return;
  lastState = st;
  setStatus(st.label, st.level, st.detail);
  // Démarrer reste possible seulement si l'état est "prêt" (ou avertissement
  // non bloquant avec prompt présent), pour ne pas mentir à l'utilisateur.
  els.start.disabled = st.code !== 'READY';
}

async function bgSend(message) {
  if (!api) return { ok: false, error: 'API navigateur indisponible' };
  try {
    const resp = await api.runtime.sendMessage(message);
    if (resp === undefined || resp === null) {
      return { ok: false, error: 'Réponse vide du service worker (SW endormi ?)' };
    }
    return resp;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function sendToContent(payload) {
  const resp = await bgSend({ type: 'SEND_TO_CONTENT', tabId: flowTabId, payload });
  return resp;
}

function logLine(text) {
  // Journal local visible même si le storage est indisponible.
  const stamp = new Date().toLocaleTimeString();
  els.log.textContent = (els.log.textContent + '\n[' + stamp + '] UI: ' + text).trim();
  els.log.scrollTop = els.log.scrollHeight;
}

// --- Lecture des logs persistés --------------------------------------------

async function refreshLogs() {
  let logs = [];
  try { logs = await FlowAutomation.storage.get('logs'); } catch (e) { logs = []; }
  if (!Array.isArray(logs)) logs = [];
  const last = logs.slice(-80);
  els.log.textContent = last.map((l) => {
    const time = new Date(l.ts).toLocaleTimeString();
    return `[${time}] ${String(l.level || 'info').toUpperCase()}: ${l.message}`;
  }).join('\n');
}

// --- File d'attente ---------------------------------------------------------

async function refreshQueueFromStorage() {
  let q = null;
  try { q = await FlowAutomation.storage.get('queue'); } catch (e) { q = null; }
  if (q && q.items) queueSnapshot = q;
  renderQueue();
}

function renderQueue() {
  if (!queueSnapshot || !queueSnapshot.items) {
    els.progress.textContent = '0 / 0';
    els.current.textContent = '—';
    els.items.innerHTML = '<li>Aucun prompt</li>';
    return updateControls();
  }
  const items = queueSnapshot.items;
  const done = items.filter((it) => it.status === 'COMPLETED').length;
  els.progress.textContent = done + ' / ' + items.length;

  const cur = queueSnapshot.currentIndex >= 0 ? items[queueSnapshot.currentIndex] : null;
  els.current.textContent = cur ? cur.prompt.substring(0, 60) : '—';

  els.items.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    const spanP = document.createElement('span');
    spanP.className = 'item-prompt';
    spanP.textContent = it.prompt;
    const spanS = document.createElement('span');
    spanS.className = 'item-status st-' + it.status;
    spanS.textContent = String(it.status).replace(/_/g, ' ');
    li.appendChild(spanP);
    li.appendChild(spanS);
    els.items.appendChild(li);
  }
  updateControls();
}

function updateControls() {
  const running = !!(queueSnapshot && queueSnapshot.isRunning);
  const paused = !!(queueSnapshot && queueSnapshot.isPaused);
  const ready = !!(lastState && lastState.code === 'READY');
  els.start.disabled = running || !ready;
  els.pause.disabled = !running || paused;
  els.resume.disabled = !paused;
  els.cancel.disabled = !running;
}

// --- Vérification réelle de la chaîne --------------------------------------

/**
 * Détermine si le content script est réellement présent dans l'onglet.
 * Utilise ENSURE_CONTENT du background (PING + réinjection contrôlée).
 * Retourne { present, injected, injectAttempted, injectError }.
 */
async function probeContent() {
  const ens = await bgSend({ type: 'ENSURE_CONTENT' });
  if (ens && ens.ok) {
    return {
      present: !!ens.present,
      injected: !!ens.injected,
      injectAttempted: !!ens.injectAttempted,
      injectError: ens.injectError || null
    };
  }
  // Repli : PING direct, pour ne pas confondre "absent" et "SW en erreur".
  const ping = await sendToContent({ type: 'PING' });
  const pong = !!(ping && ping.ok && ping.value && ping.value.pong);
  return { present: pong, injected: false, injectAttempted: false, injectError: (ens && ens.error) || null };
}

/**
 * Interroge le service worker (GET_ACTIVE_FLOW_TAB), puis sonde le content
 * script (ENSURE_CONTENT + GET_PAGE_STATE), et dérive un état explicite.
 * Aucun masquage d'erreur.
 */
async function checkFlowPage() {
  const facts = {
    apiAvailable: !!api, tab: null, contentPresent: false,
    injectAttempted: false, injectError: null, pageState: null,
    error: null, errorStage: null
  };
  setStatus('Vérification…', 'busy', '');

  if (!api) {
    applyState({ code: 'API_UNAVAILABLE', label: 'API navigateur indisponible', detail: 'chrome/browser.runtime absent', level: 'err' });
    return false;
  }

  // 1) Onglet cible
  const tabResp = await bgSend({ type: 'GET_ACTIVE_FLOW_TAB' });
  if (!tabResp || !tabResp.ok) {
    facts.error = (tabResp && tabResp.error) || 'aucune réponse du service worker';
    facts.errorStage = 'QUERY_TABS';
    logLine('Échec recherche onglet : ' + facts.error);
    applyState(statusLib ? statusLib.derive(facts) : { code: 'TAB_QUERY_ERROR', label: 'Erreur de recherche des onglets', detail: facts.error, level: 'err' });
    return false;
  }

  flowTabId = tabResp.tabId || null;
  facts.tab = { id: tabResp.tabId, url: tabResp.url, status: tabResp.status };

  if (!tabResp.isFlow) {
    logLine('Onglet actif non-Flow : ' + (tabResp.url || '(inconnu)'));
    applyState(statusLib ? statusLib.derive({ ...facts, contentPresent: false }) : {
      code: 'NOT_FLOW', label: 'Onglet actif ≠ Google Flow', detail: 'URL : ' + (tabResp.url || ''), level: 'err'
    });
    return false;
  }

  // 2) Présence réelle du content script (PING + réinjection contrôlée).
  const probe = await probeContent();
  facts.contentPresent = probe.present;
  facts.injectAttempted = probe.injectAttempted;
  facts.injectError = probe.injectError;
  logLine('Sonde content script : ' + (probe.present ? 'présent' : 'ABSENT') +
    (probe.injected ? ' (réinjecté)' : '') + (probe.injectError ? ' — ' + probe.injectError : ''));

  if (!probe.present) {
    facts.error = probe.injectError || null;
    facts.errorStage = 'SEND';
    applyState(statusLib ? statusLib.derive(facts) : {
      code: 'CONTENT_ABSENT', label: 'Content script absent',
      detail: probe.injectError || 'Le script de contenu ne répond pas', level: 'err'
    });
    return false;
  }

  // 3) État de la page auprès du content script.
  const ps = await sendToContent({ type: 'GET_PAGE_STATE' });
  if (!ps || !ps.ok || !ps.value) {
    // Content présent (PING OK) mais pas de réponse à GET_PAGE_STATE.
    facts.pageState = null;
    facts.error = (ps && ps.error) || 'aucune réponse au GET_PAGE_STATE';
    facts.errorStage = 'PAGE_STATE';
    logLine('GET_PAGE_STATE sans réponse : ' + facts.error);
    applyState(statusLib ? statusLib.derive(facts) : {
      code: 'CONTENT_NO_RESPONSE', label: 'Content script sans réponse', detail: facts.error, level: 'err'
    });
    return false;
  }

  facts.pageState = ps.value;
  const st = statusLib ? statusLib.derive(facts) : {
    code: ps.value.hasPrompt ? 'READY' : 'PROJECT_NO_PROMPT',
    label: ps.value.hasPrompt ? 'Prêt' : 'Champ de prompt introuvable',
    detail: 'readyState=' + ps.value.readyState, level: ps.value.hasPrompt ? 'ok' : 'err'
  };
  applyState(st);
  logLine('État page : ' + st.code + ' — ' + (st.detail || ''));
  return st.code === 'READY';
}

// --- Diagnostic complet -----------------------------------------------------

function fmtDiag(r) {
  const L = [];
  const yn = (v) => (v ? 'OUI' : 'NON');
  L.push('Flow Automation V0.1.1 — Diagnostic');
  L.push('Date : ' + new Date(r.ts || Date.now()).toLocaleString());
  L.push('');
  L.push('== API ==');
  L.push('runtime        : ' + yn(r.apiAvailable));
  L.push('tabs.query     : ' + yn(r.hasTabs));
  L.push('scripting      : ' + yn(r.hasScripting));
  L.push('downloads      : ' + yn(r.hasDownloads));
  L.push('storage        : ' + yn(r.hasStorage));
  L.push('');
  L.push('== ONGLET ==');
  L.push('onglets Flow   : ' + (r.flowTabs != null ? r.flowTabs : '?'));
  if (r.tab) {
    L.push('id             : ' + r.tab.id);
    L.push('url            : ' + r.tab.url);
    L.push('status         : ' + r.tab.status);
    L.push('actif          : ' + yn(r.tab.active));
  } else {
    L.push('(aucun onglet)');
  }
  L.push('');
  L.push('== CONTENT SCRIPT ==');
  L.push('présent        : ' + yn(r.contentPresent));
  L.push('réinjecté      : ' + yn(r.contentInjected));
  if (r.injectError) L.push('erreur inject  : ' + r.injectError);
  if (r.pageState) {
    L.push('');
    L.push('== PAGE ==');
    L.push('url            : ' + (r.pageState.url || ''));
    L.push('isFlowPage     : ' + yn(r.pageState.isFlowPage));
    L.push('isInProject    : ' + yn(r.pageState.isInProject));
    L.push('readyState     : ' + r.pageState.readyState);
    L.push('app montée     : ' + yn(r.pageState.hasAppRoot));
    L.push('champ prompt   : ' + yn(r.pageState.hasPrompt));
    L.push('bouton générer : ' + yn(r.pageState.hasSubmit));
    L.push('tuiles         : ' + r.pageState.tiles);
    L.push('médias         : ' + r.pageState.medias);
  }
  if (r.error) L.push('\nERREUR : ' + r.error + (r.errorStage ? ' (' + r.errorStage + ')' : ''));
  L.push('');
  L.push('== VERDICT ==');
  if (r.status) L.push('[' + r.status.level + '] ' + r.status.label + (r.status.detail ? ' — ' + r.status.detail : ''));
  return L.join('\n');
}

async function runDiagnose() {
  setStatus('Diagnostic…', 'busy', '');
  els.diagCard.style.display = 'block';
  els.diagReport.textContent = 'Exécution du diagnostic…';
  const r = await bgSend({ type: 'DIAGNOSE' });
  if (!r || r.ok === false && !r.status) {
    els.diagReport.textContent = 'Diagnostic impossible : ' + ((r && r.error) || 'service worker injoignable');
    return;
  }
  els.diagReport.textContent = fmtDiag(r);
  if (r.status) applyState(r.status);
  if (r.tab && r.tab.id) flowTabId = r.tab.id;
}

// --- Paramètres -------------------------------------------------------------

async function saveSettings() {
  const s = await FlowAutomation.storage.get('settings');
  s.model = els.setModel.value.trim() || null;
  s.aspectRatio = els.setRatio.value.trim() || null;
  s.outputCount = els.setCount.value ? parseInt(els.setCount.value, 10) : null;
  s.downloadFolder = els.setFolder.value.trim() || 'flow-automation';
  await FlowAutomation.storage.set('settings', s);
}

async function loadSettings() {
  const s = await FlowAutomation.storage.get('settings');
  els.setModel.value = s.model || '';
  els.setRatio.value = s.aspectRatio || '';
  els.setCount.value = s.outputCount || '';
  els.setFolder.value = s.downloadFolder || 'flow-automation';
}

// --- Actions ----------------------------------------------------------------

async function onStart() {
  const prompts = els.prompts.value.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (prompts.length === 0) {
    setStatus('Aucun prompt valide', 'err', 'Saisissez au moins une ligne non vide.');
    return;
  }

  await saveSettings();

  // 1) Vérification réelle de la chaîne (avec réinjection contrôlée).
  const ready = await checkFlowPage();
  if (!ready) {
    logLine('Démarrage refusé : état \u2260 READY (' + (lastState && lastState.code) + ')');
    return;
  }

  // 2) Création de la file côté content script.
  const created = await sendToContent({ type: 'QUEUE_CREATE', prompts });
  if (!created || !created.ok) {
    setStatus('Création de la file impossible', 'err', (created && created.error) || 'content script muet');
    return;
  }

  // 3) Démarrage et confirmation que la file tourne réellement.
  const started = await sendToContent({ type: 'QUEUE_START' });
  if (!started || !started.ok) {
    setStatus('Démarrage impossible', 'err', (started && started.error) || 'content script muet');
    return;
  }

  const got = await sendToContent({ type: 'QUEUE_GET' });
  const state = got && got.value;
  if (!state || !state.items || !state.isRunning) {
    setStatus('La file ne démarre pas', 'err',
      'Le content script a répondu mais la file n\u2019est pas active. Voir Diagnostic.');
    return;
  }

  els.prompts.value = '';
  setStatus('File démarrée', 'ok', state.items.length + ' prompt(s) en file.');
  logLine('File démarrée (' + state.items.length + ' prompts)');
  queueSnapshot = state;
  renderQueue();
}

async function onPause() {
  const r = await sendToContent({ type: 'QUEUE_PAUSE' });
  if (r && r.ok) setStatus('En pause', 'warn', 'La pause prend effet entre deux prompts.');
  else setStatus('Pause impossible', 'err', (r && r.error) || '');
}

async function onResume() {
  const r = await sendToContent({ type: 'QUEUE_RESUME' });
  if (r && r.ok) { setStatus('Reprise', 'ok', ''); setTimeout(() => checkFlowPage(), 600); }
  else setStatus('Reprise impossible', 'err', (r && r.error) || '');
}

async function onCancel() {
  const r = await sendToContent({ type: 'QUEUE_CANCEL' });
  if (r && r.ok) setStatus('Annulé', 'warn', '');
  else setStatus('Annulation impossible', 'err', (r && r.error) || '');
}

// --- Messages entrants ------------------------------------------------------

if (api && api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'QUEUE_SNAPSHOT') {
      queueSnapshot = message.value;
      renderQueue();
    }
  });
}

// --- Bindings ---------------------------------------------------------------

els.recheck.addEventListener('click', () => checkFlowPage());
els.diagnose.addEventListener('click', runDiagnose);
els.copyDiag.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.diagReport.textContent || '');
    els.copyDiag.textContent = 'Copié !';
    setTimeout(() => { els.copyDiag.textContent = 'Copier le rapport'; }, 1500);
  } catch (e) {
    // Repli : sélectionner le texte pour copie manuelle.
    const range = document.createRange();
    range.selectNodeContents(els.diagReport);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});
els.start.addEventListener('click', onStart);
els.pause.addEventListener('click', onPause);
els.resume.addEventListener('click', onResume);
els.cancel.addEventListener('click', onCancel);

// --- Init -------------------------------------------------------------------

(async function init() {
  logLine('Popup ouvert');
  await loadSettings();
  await refreshLogs();
  await refreshQueueFromStorage();
  await checkFlowPage();
})();

// --- Filets de sécurité : rafraîchissement périodique ----------------------
// Les messages QUEUE_SNAPSHOT du content script peuvent ne pas toujours
// atteindre la popup (selon le navigateur). On relit donc aussi le storage.
setInterval(refreshQueueFromStorage, 2500);
setInterval(refreshLogs, 3000);
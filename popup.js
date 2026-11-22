/**
 * popup.js
 * Interface utilisateur : saisie des prompts, contrôles (démarrer/pause/
 * reprendre/annuler), affichage de la file, des logs et du statut de la page.
 *
 * Communication :
 *  - la file (queue-manager) vit dans le content script (onglet flow.google.com)
 *  - les contrôles sont relayés au content script via le background
 *    (message SEND_TO_CONTENT)
 *  - l'état de la file est reçu par chrome.runtime.onMessage depuis le content
 *    script (PROMPT_GROUP_STATUS-like simplifié) OU lu depuis storage.local
 *    (filet de sécurité).
 */

'use strict';

const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

const els = {
  status: document.getElementById('page-status'),
  prompts: document.getElementById('prompts'),
  start: document.getElementById('btn-start'),
  pause: document.getElementById('btn-pause'),
  resume: document.getElementById('btn-resume'),
  cancel: document.getElementById('btn-cancel'),
  progress: document.getElementById('queue-progress'),
  current: document.getElementById('current-prompt'),
  items: document.getElementById('queue-items'),
  log: document.getElementById('log-area'),
  setModel: document.getElementById('set-model'),
  setRatio: document.getElementById('set-ratio'),
  setCount: document.getElementById('set-count'),
  setFolder: document.getElementById('set-folder')
};

// --- État local ---
let flowTabId = null;
let queueSnapshot = null;

// --- Helpers ---

async function sendToContent(message) {
  try {
    const resp = await api.runtime.sendMessage({
      type: 'SEND_TO_CONTENT',
      tabId: flowTabId,
      payload: message
    });
    return resp;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function getActiveFlowTab() {
  try {
    const resp = await api.runtime.sendMessage({ type: 'GET_ACTIVE_FLOW_TAB' });
    if (resp && resp.ok) return resp.tabId;
    return null;
  } catch (e) {
    return null;
  }
}

// --- Lecture des logs depuis storage (affichage) ---
async function refreshLogs() {
  const logs = await FlowAutomation.storage.get('logs');
  const last = logs.slice(-50);
  els.log.textContent = last.map((l) => {
    const d = new Date(l.ts);
    const time = d.toLocaleTimeString();
    return `[${time}] ${l.level.toUpperCase()}: ${l.message}`;
  }).join('\n');
}

// --- Lecture de l'état de la file (filet de sécurité storage) ---
async function refreshQueueFromStorage() {
  const q = await FlowAutomation.storage.get('queue');
  if (q && q.items) queueSnapshot = q;
  renderQueue();
}

// --- Rendu de la file ---
function renderQueue() {
  if (!queueSnapshot || !queueSnapshot.items) {
    els.progress.textContent = '0 / 0';
    els.current.textContent = '—';
    els.items.innerHTML = '<li>Aucun prompt</li>';
    return;
  }
  const items = queueSnapshot.items;
  const done = items.filter((it) => it.status === 'COMPLETED').length;
  els.progress.textContent = done + ' / ' + items.length;

  const cur = queueSnapshot.currentIndex >= 0
    ? items[queueSnapshot.currentIndex]
    : null;
  els.current.textContent = cur ? cur.prompt.substring(0, 60) : '—';

  els.items.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    const spanP = document.createElement('span');
    spanP.className = 'item-prompt';
    spanP.textContent = it.prompt;
    const spanS = document.createElement('span');
    spanS.className = 'item-status st-' + it.status;
    spanS.textContent = it.status.replace(/_/g, ' ');
    li.appendChild(spanP);
    li.appendChild(spanS);
    els.items.appendChild(li);
  }

  // boutons selon l'état
  const running = !!queueSnapshot.isRunning;
  const paused = !!queueSnapshot.isPaused;
  els.start.disabled = running;
  els.pause.disabled = !running || paused;
  els.resume.disabled = !paused;
  els.cancel.disabled = !running;
}

// --- Vérification de la page flow ---
async function checkFlowPage() {
  flowTabId = await getActiveFlowTab();
  if (!flowTabId) {
    els.status.textContent = 'Aucun onglet Flow';
    els.status.className = 'status err';
    els.start.disabled = true;
    return false;
  }
  const resp = await sendToContent({ type: 'GET_PAGE_STATE' });
  if (resp && resp.ok && resp.value && resp.value.hasPrompt) {
    els.status.textContent = 'Prêt (' + resp.value.tiles + ' tuile)';
    els.status.className = 'status ok';
    return true;
  }
  els.status.textContent = resp && resp.value && resp.value.isFlowPage
    ? 'Connecté mais champ introuvable'
    : 'Onglet Flow non prêt';
  els.status.className = 'status err';
  return false;
}

// --- Persistance des paramètres ---
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

// --- Actions ---
async function onStart() {
  const text = els.prompts.value;
  const prompts = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (prompts.length === 0) {
    els.status.textContent = 'Entrez au moins un prompt';
    els.status.className = 'status err';
    return;
  }
  await saveSettings();
  const ok = await checkFlowPage();
  if (!ok) return;

  // Envoie la nouvelle file au content script
  const resp = await sendToContent({ type: 'QUEUE_CREATE', prompts });
  if (!resp || !resp.ok) {
    els.status.textContent = 'Envoi impossible au content script';
    els.status.className = 'status err';
    return;
  }
  // Démarre
  await sendToContent({ type: 'QUEUE_START' });
  els.prompts.value = '';
  els.status.textContent = 'File démarrée';
  els.status.className = 'status ok';
  setTimeout(() => checkFlowPage(), 500);
}

async function onPause() {
  await sendToContent({ type: 'QUEUE_PAUSE' });
  els.status.textContent = 'En pause';
}

async function onResume() {
  await sendToContent({ type: 'QUEUE_RESUME' });
  els.status.textContent = 'Reprise';
  setTimeout(() => checkFlowPage(), 500);
}

async function onCancel() {
  await sendToContent({ type: 'QUEUE_CANCEL' });
  els.status.textContent = 'Annulé';
}

// --- Messages entrants du content script ---
api.runtime.onMessage.addListener((message) => {
  if (!message) return;
  switch (message.type) {
    case 'QUEUE_SNAPSHOT':
      queueSnapshot = message.value;
      renderQueue();
      break;
    case 'PAGE_STATE':
      if (message.value) {
        els.status.textContent = message.value.hasPrompt ? 'Prêt' : 'Champ introuvable';
        els.status.className = message.value.hasPrompt ? 'status ok' : 'status err';
      }
      break;
  }
});

// --- Récupération des logs / état (polling léger) ---
setInterval(refreshLogs, 2000);
setInterval(refreshQueueFromStorage, 3000);

// --- Écoute des changements storage (logs) ---
FlowAutomation.storage.onChanged((changes) => {
  if (changes.logs) refreshLogs();
  if (changes.queue) refreshQueueFromStorage();
});

// --- Bindings ---
els.start.addEventListener('click', onStart);
els.pause.addEventListener('click', onPause);
els.resume.addEventListener('click', onResume);
els.cancel.addEventListener('click', onCancel);

// --- Init ---
(async function init() {
  await loadSettings();
  await checkFlowPage();
  await refreshLogs();
  await refreshQueueFromStorage();
  // demande l'état actuel au content script s'il est présent
  const resp = await sendToContent({ type: 'GET_PAGE_STATE' });
  if (resp && resp.ok) {
    els.status.textContent = resp.value.hasPrompt ? 'Prêt' : 'Champ introuvable';
    els.status.className = resp.value.hasPrompt ? 'status ok' : 'status err';
  }
})();

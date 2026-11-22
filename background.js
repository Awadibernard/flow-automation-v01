/**
 * background.js — Flow Automation V0.1.4
 * Service worker MV3.
 *
 * Responsabilités :
 *  - trouver l'onglet Google Flow cible (recherche robuste, compatible Quetta)
 *  - garantir la présence du content script (PING puis réinjection contrôlée)
 *  - relayer les messages entre popup et content script
 *  - télécharger les médias (chrome.downloads)
 *  - produire un rapport de diagnostic complet (DIAGNOSE)
 *  - journaliser dans chrome.storage.local (logs exploitables depuis la popup)
 *
 * Compatibilité : opère sur l'API `chrome` (navigateurs Chromium, dont Quetta
 * Android). Repli défensif si `browser` est le seul namespace disponible.
 */

'use strict';

// --- Couche d'adaptation navigateurs ---------------------------------------
// Attention : `browser` (namespace promisifié) n'est pas toujours présent sur
// les forks Chromium. On privilégie `chrome`, avec repli sur `browser`.
const N = (typeof chrome !== 'undefined' && chrome.runtime)
  ? chrome
  : (typeof browser !== 'undefined' ? browser : null);

// Fichiers du content script, DANS L'ORDRE de dépendance.
// Utilisés pour la réinjection contrôlée si le content script est absent.
const CONTENT_FILES = [
  'status.js',
  'storage-manager.js',
  'flow-dom.js',
  'generation-manager.js',
  'download-manager.js',
  'queue-manager.js',
  'content.js'
];

const MAX_LOGS = 500;
const FLOW_MATCH_PATTERNS = ['*://flow.google.com/*', '*://*.flow.google.com/*'];

// Mémoire anti-boucle d'injection : { tabId: timestamp }.
const injectedTabs = {};

// --- Journalisation ---------------------------------------------------------

async function log(level, message, data) {
  try {
    const obj = await N.storage.local.get('logs');
    const logs = (obj && obj.logs) || [];
    logs.push({ level: level || 'info', message: String(message), data: data || null, ts: Date.now(), src: 'bg' });
    const trimmed = logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs;
    await N.storage.local.set({ logs: trimmed });
  } catch (e) {
    console.error('[background] log failed', e);
  }
}

// --- Recherche de l'onglet cible -------------------------------------------

function isFlowUrl(url) {
  return /^https?:\/\/([a-z0-9-]+\.)*flow\.google\.com\//i.test(String(url || ''));
}

/**
 * Renvoie l'onglet cible pour Flow Automation.
 * Priorité : onglet Flow actif > onglet Flow quelconque > onglet actif (pour
 * pouvoir expliquer "l'onglet actif n'est pas Flow").
 * Return { ok, tab?, count?, error? }
 */
async function findTargetTab() {
  try {
    let all = [];
    try {
      // Requête filtrée : plus précis (nécessite la permission tabs).
      all = await N.tabs.query({ url: FLOW_MATCH_PATTERNS });
    } catch (e1) {
      // Certains forks/versions ignorent ou refusent le filtre `url`.
      all = await N.tabs.query({});
    }
    // Filet : si la requête filtrée a renvoyé vide, tenter une requête complète.
    if (!all || all.length === 0) {
      try { all = await N.tabs.query({}); } catch (e2) { all = []; }
    }

    const flowTabs = all.filter((t) => isFlowUrl(t.url));
    if (flowTabs.length > 0) {
      const active = flowTabs.find((t) => t.active);
      const chosen = active || flowTabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      return { ok: true, tab: chosen, count: flowTabs.length, isFlow: true };
    }

    // Aucun onglet Flow : on retourne l'onglet actif pour diagnostic.
    const activeTab = all.find((t) => t.active) || all[0] || null;
    return { ok: true, tab: activeTab, count: 0, isFlow: false };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// --- Communication avec le content script -----------------------------------

/**
 * Envoie un message au content script d'un onglet. Ne jette pas.
 * Return { ok, value?, error?, errorStage }
 */
async function rawSendToTab(tabId, message) {
  if (!tabId) return { ok: false, error: 'Aucun tabId', errorStage: 'SEND' };
  try {
    const resp = await N.tabs.sendMessage(tabId, message);
    return { ok: true, value: resp };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), errorStage: 'SEND' };
  }
}

/**
 * Garantit la présence du content script dans l'onglet.
 * 1) PING ; 2) si échec, réinjection unique via chrome.scripting ; 3) re-PING.
 * Return { present, injected, injectAttempted, injectError, error }
 */
async function ensureContent(tabId) {
  const first = await rawSendToTab(tabId, { type: 'PING' });
  if (first.ok && first.value && first.value.pong) {
    return { present: true, injected: false, injectAttempted: false, injectError: null, error: null };
  }

  // Anti-boucle : une seule tentative d'injection par onglet (fenêtre large).
  const now = Date.now();
  const last = injectedTabs[tabId] || 0;
  if (now - last < 5000) {
    return {
      present: false, injected: false, injectAttempted: true,
      injectError: 'Réinjection déjà tentée récemment (anti-boucle)',
      error: first.error
    };
  }
  injectedTabs[tabId] = now;

  // Réinjection contrôlée.
  let injectError = null;
  let injected = false;
  try {
    if (!N.scripting || !N.scripting.executeScript) {
      injectError = 'API chrome.scripting indisponible dans ce navigateur';
    } else {
      await N.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES });
      injected = true;
    }
  } catch (e) {
    injectError = String((e && e.message) || e);
  }

  if (injectError) {
    return { present: false, injected: false, injectAttempted: true, injectError: injectError, error: first.error };
  }

  // Petit délai pour laisser le script s'initialiser, puis re-PING.
  await sleep(600);
  const second = await rawSendToTab(tabId, { type: 'PING' });
  if (second.ok && second.value && second.value.pong) {
    await log('info', 'Content script réinjecté avec succès dans l\'onglet ' + tabId);
    return { present: true, injected: true, injectAttempted: true, injectError: null, error: null };
  }
  return {
    present: false, injected: injected, injectAttempted: true,
    injectError: injectError, error: second.error || 'aucune réponse après injection'
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Récupère l'état de la page auprès du content script.
 * Return { ok, value?, error? }
 */
async function getPageState(tabId) {
  return rawSendToTab(tabId, { type: 'GET_PAGE_STATE' });
}

// --- Diagnostic complet -----------------------------------------------------

/**
 * Exécute la chaîne complète : API → onglet → content script → état page.
 * Return un rapport structuré (jamais de throw).
 */
async function diagnose() {
  const report = {
    ts: Date.now(),
    apiAvailable: !!N && !!N.runtime,
    hasTabs: !!(N && N.tabs && N.tabs.query),
    hasScripting: !!(N && N.scripting && N.scripting.executeScript),
    hasDownloads: !!(N && N.downloads),
    hasStorage: !!(N && N.storage),
    tab: null,
    flowTabs: 0,
    contentPresent: false,
    contentInjected: false,
    injectAttempted: false,
    injectError: null,
    pageState: null,
    status: null,
    error: null,
    errorStage: null
  };

  if (!report.apiAvailable) {
    report.status = { code: 'API_UNAVAILABLE', label: 'API navigateur indisponible', detail: 'chrome.runtime absent', level: 'err' };
    return report;
  }

  const found = await findTargetTab();
  if (!found.ok) {
    report.error = found.error;
    report.errorStage = 'QUERY_TABS';
    report.status = { code: 'TAB_QUERY_ERROR', label: 'Erreur de recherche des onglets', detail: found.error, level: 'err' };
    return report;
  }
  if (found.tab) {
    report.tab = { id: found.tab.id, url: found.tab.url, status: found.tab.status, active: !!found.tab.active };
    report.flowTabs = found.count;
  }

  if (!found.tab) {
    report.status = { code: 'NO_TAB', label: 'Aucun onglet Google Flow ouvert', detail: 'Aucun onglet retourné', level: 'err' };
    return report;
  }

  if (found.count === 0) {
    report.status = { code: 'NOT_FLOW', label: 'Onglet actif ≠ Google Flow', detail: 'URL détectée : ' + (found.tab.url || ''), level: 'err' };
    return report;
  }

  const ensured = await ensureContent(found.tab.id);
  report.contentPresent = ensured.present;
  report.contentInjected = ensured.injected;
  report.injectAttempted = ensured.injectAttempted;
  report.injectError = ensured.injectError;
  report.error = ensured.error;

  if (!ensured.present) {
    report.errorStage = 'SEND';
    report.status = {
      code: ensured.injectAttempted && ensured.injectError ? 'CONTENT_ABSENT' : 'CONTENT_NO_RESPONSE',
      label: ensured.injectAttempted && ensured.injectError
        ? 'Content script absent (injection échouée)'
        : 'Content script absent',
      detail: ensured.injectError || ensured.error || '',
      level: 'err'
    };
    return report;
  }

  const ps = await getPageState(found.tab.id);
  if (!ps.ok || !ps.value) {
    report.error = ps.error;
    report.errorStage = 'PAGE_STATE';
    report.status = { code: 'CONTENT_NO_RESPONSE', label: 'Content script sans réponse', detail: ps.error || '', level: 'err' };
    return report;
  }
  report.pageState = ps.value;

  // Calcul du statut final. NOTE : deriveStatus() ci-dessous est le miroir
  // exact de status.js côté popup ; les deux doivent rester synchronisés. Le
  // service worker est un worker isolé, on garde donc une copie locale plutôt
  // qu'un import (qui casserait le chargement classique de status.js dans la
  // popup et les tests Node).
  report.status = deriveStatus({
    apiAvailable: true,
    tab: report.tab,
    contentPresent: true,
    injectAttempted: true,
    injectError: null,
    pageState: report.pageState,
    error: null,
    errorStage: null
  });

  return report;
}

// --- Repli : logique de statut minimale (miroir de status.js) ----------------
function deriveStatus(i) {
  const mk = (code, label, detail, level) => ({ code, label, detail: detail || '', level });
  if (!i || i.apiAvailable === false) return mk('API_UNAVAILABLE', 'API navigateur indisponible', '', 'err');
  if (i.error && i.errorStage === 'QUERY_TABS') return mk('TAB_QUERY_ERROR', 'Erreur de recherche des onglets', i.error, 'err');
  if (!i.tab) return mk('NO_TAB', 'Aucun onglet Google Flow ouvert', '', 'err');
  const url = i.tab.url || '';
  const flow = isFlowUrl(url);
  const loading = (i.tab.status || 'complete') !== 'complete';
  if (!i.contentPresent) {
    if (!flow) return mk('NOT_FLOW', 'Onglet actif ≠ Google Flow', 'URL : ' + url, 'err');
    if (loading) return mk('TAB_LOADING', 'Page en cours de chargement', 'statut ' + i.tab.status, 'busy');
    return mk('CONTENT_ABSENT', 'Content script absent', i.injectError || i.error || '', 'err');
  }
  const ps = i.pageState || {};
  if (loading || ps.readyState === 'loading') return mk('TAB_LOADING', 'Page en cours de chargement', ps.readyState || i.tab.status, 'busy');
  if (!ps.isInProject && !/\/project\//.test(url)) return mk('FLOW_NOT_PROJECT', 'Aucun projet ouvert', '', 'warn');
  if (!ps.hasPrompt) return mk('PROJECT_NO_PROMPT', 'Champ de prompt introuvable', '', 'err');
  if (ps.hasSubmit === false) return mk('PROMPT_NO_SUBMIT', 'Bouton de génération introuvable', '', 'warn');
  return mk('READY', 'Prêt à générer', (ps.tiles || 0) + ' tuile(s)', 'ok');
}

// --- Téléchargement ---------------------------------------------------------

async function downloadMedia(url, filename, folder) {
  try {
    const options = { url };
    if (filename) options.filename = filename;
    if (folder) options.saveAs = false;
    const downloadId = await N.downloads.download(options);
    return { ok: true, downloadId };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// --- Sélecteurs -------------------------------------------------------------

async function getSelectors() {
  const fallback = { version: 0, selectors: {}, options: {}, durations: {} };
  try {
    let obj = await N.storage.local.get('selectors');
    if (!obj || !obj.selectors || !obj.selectors.version) {
      await initSelectors();
      obj = await N.storage.local.get('selectors');
    }
    if (obj && obj.selectors) return obj.selectors;
    return fallback;
  } catch (e) {
    console.error('[background] getSelectors failed', e);
    return fallback;
  }
}

async function initSelectors(force) {
  const EMBEDDED = {
    version: 2,
    note: 'Sélecteurs locaux — repli embarqué',
    app: { hostPattern: 'flow.google.com', projectPathPattern: '/project/' },
    selectors: {
      promptTextarea: { value: "div[contenteditable='true'][role='textbox'], div[contenteditable='true'], [role='textbox'][contenteditable], textarea", confidence: 'medium' },
      submitButton: {
        value: "button[data-test-id*='submit' i], button[data-testid*='submit' i], button[aria-label*='submit' i], button[aria-label*='send' i], button[aria-label*='generate' i], button[aria-label*='create' i], button[jsaction*='submit'], button[type='submit']",
        fallbacks: ["form button:not([disabled])", "[role='button'][aria-label*='send' i]", "[role='button']", "button:has(mat-icon)", "button:has(svg)", "button:has(i)", "button", "mat-icon"],
        confidence: 'low'
      },
      generatingIndicator: { value: "[role='progressbar'], [class*='progress']", confidence: 'low' },
      resultTiles: { value: "flow-tile, [class*='tile']", confidence: 'low' },
      tileMedia: { value: 'video, img', confidence: 'medium' }
    },
    options: {},
    durations: { generationTimeoutMs: 180000, generationStartMs: 12000, pollIntervalMs: 2000, tileStabilityChecks: 3, tileStabilityDelayMs: 1500 }
  };
  try {
    let selectors = null;
    try {
      const resp = await fetch(N.runtime.getURL('selectors.json'));
      if (resp.ok) selectors = await resp.json();
    } catch (e) {
      console.warn('[background] selectors.json illisible, repli embarqué', e);
    }
    if (!selectors || !selectors.selectors) selectors = EMBEDDED;

    // Empreinte du fichier livré : si selectors.json a changé (mise à jour de
    // l'extension, sélecteurs ajustés), on remplace la copie en storage au lieu
    // de conserver indéfiniment une version périmée.
    const fingerprint = JSON.stringify(selectors);

    if (force !== true) {
      const existing = await N.storage.local.get('selectors');
      const cur = existing && existing.selectors;
      if (cur && cur.fingerprint === fingerprint) return; // déjà à jour
    }

    await N.storage.local.set({ selectors: Object.assign({}, selectors, { fingerprint }) });
    await log('info', 'Sélecteurs synchronisés (v' + (selectors.version || '?') + ')');
  } catch (e) {
    console.error('[background] initSelectors failed', e);
  }
}

// --- Gestionnaire de messages ----------------------------------------------

N.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message && message.type) {
      case 'GET_SELECTORS':
        return { ok: true, value: await getSelectors() };

      case 'DOWNLOAD_MEDIA':
        return await downloadMedia(message.url, message.filename, message.folder);

      case 'SEND_TO_CONTENT': {
        // Relaie vers l'onglet ciblé. message.tabId optionnel : sinon on cherche.
        let tabId = message.tabId;
        if (!tabId) {
          const found = await findTargetTab();
          tabId = found.tab && found.tab.id;
        }
        const resp = await rawSendToTab(tabId, message.payload);
        return resp.ok ? { ok: true, value: resp.value } : { ok: false, error: resp.error };
      }

      case 'GET_ACTIVE_FLOW_TAB': {
        const found = await findTargetTab();
        if (!found.ok) return { ok: false, error: found.error };
        if (!found.tab) return { ok: false, error: 'Aucun onglet' };
        return {
          ok: true,
          tabId: found.tab.id,
          url: found.tab.url,
          status: found.tab.status,
          isFlow: found.isFlow,
          flowTabs: found.count
        };
      }

      case 'ENSURE_CONTENT': {
        const found = await findTargetTab();
        if (!found.ok || !found.tab) return { ok: false, error: (found.error || 'Aucun onglet') };
        const ensured = await ensureContent(found.tab.id);
        return { ok: true, tabId: found.tab.id, ...ensured };
      }

      case 'DIAGNOSE':
        return await diagnose();

      default:
        return { ok: false, error: 'Type de message inconnu : ' + (message && message.type) };
    }
  })().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // réponse asynchrone
});

// --- Lifecycle --------------------------------------------------------------

N.runtime.onInstalled.addListener((details) => {
  const reason = (details && details.reason) || 'unknown';
  log('info', 'Extension installée / mise à jour (V0.1.4), raison : ' + reason);
  // force = true : une mise à jour doit remplacer des sélecteurs périmés.
  initSelectors(true);
});

// Au démarrage du worker on ne force pas : on ne réécrit que si le fichier livré
// a changé (comparaison d'empreinte), pour préserver un ajustement manuel.
initSelectors(false);
log('info', 'Service worker Flow Automation V0.1.4 démarré');

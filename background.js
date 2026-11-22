/**
 * background.js
 * Service worker MV3.
 * Responsabilités :
 *  - relayer les messages entre popup et content script
 *  - télécharger les médias (chrome.downloads)
 *  - servir les sélecteurs locaux au content script
 *
 * Utilise l'API runtime de l'extension. Une couche d'adaptation minimaliste
 * (window.browser || chrome) permet un fonctionnement dans les navigateurs
 * compatibles qui exposent une API similaire.
 */

'use strict';

// --- Couche d'adaptation navigateurs (Quetta / Chrome / Firefox compatible) ---
const api = (typeof browser !== 'undefined' && browser.runtime)
  ? browser
  : chrome;

const BROWSER_API = {
  storage: api.storage,
  downloads: api.downloads,
  tabs: api.tabs,
  runtime: api.runtime
};

// --- Utilitaires ---

/**
 * Envoie un message à un content script. Retourne { ok, value|error }.
 */
async function sendToTab(tabId, message) {
  if (!tabId) return { ok: false, error: 'No tabId' };
  try {
    const resp = await BROWSER_API.tabs.sendMessage(tabId, message);
    return { ok: true, value: resp };
  } catch (e) {
    // Receiving end does not exist = pas de content script dans l'onglet
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * Télécharge un média. Retourne { ok, downloadId|error }.
 * filename et folder sont optionnels.
 */
async function downloadMedia(url, filename, folder) {
  try {
    const options = { url };
    if (filename) options.filename = filename;
    if (folder) options.saveAs = false;
    const downloadId = await BROWSER_API.downloads.download(options);
    return { ok: true, downloadId };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * Récupère les sélecteurs locaux. Retourne l'objet complet.
 */
async function getSelectors() {
  const fallback = {
    version: 0,
    selectors: {},
    options: {},
    durations: {}
  };
  try {
    let obj = await BROWSER_API.storage.local.get('selectors');
    // Course au démarrage : le content script peut interroger avant que
    // initSelectors() ait terminé. On force alors l'initialisation.
    if (!obj || !obj.selectors || !obj.selectors.version) {
      await initSelectors();
      obj = await BROWSER_API.storage.local.get('selectors');
    }
    if (obj && obj.selectors) return obj.selectors;
    return fallback;
  } catch (e) {
    console.error('[background] getSelectors failed', e);
    return fallback;
  }
}

// --- Initialisation : injecter selectors.json dans le storage ---
async function initSelectors() {
  const EMBEDDED = {
    version: 1,
    note: 'Sélecteurs locaux — repli embarqué (selectors.json indisponible)',
    app: {
      hostPattern: 'flow.google.com',
      projectPathPattern: '/project/'
    },
    selectors: {
      promptTextarea: { value: "div[contenteditable='true'][role='textbox']", confidence: 'medium' },
      submitButton: { value: "button[jsaction*='submit'], button[aria-label*='Create' i], button[aria-label*='Generate' i]", confidence: 'low' },
      generatingIndicator: { value: "[role='progressbar'], [class*='progress']", confidence: 'low' },
      resultTiles: { value: "flow-tile, [class*='tile']", confidence: 'low' },
      tileMedia: { value: 'video, img', confidence: 'medium' }
    },
    options: {
      model: { selectorTemplate: 'mat-option, flow-select-option', optionMatch: 'textContent', confidence: 'low' },
      aspectRatio: { selectorTemplate: 'mat-option, flow-select-option', optionMatch: 'textContent', confidence: 'low' },
      outputCount: { selectorTemplate: 'mat-option, flow-select-option', optionMatch: 'textContent', confidence: 'low' }
    },
    durations: { generationTimeoutMs: 180000, pollIntervalMs: 2000, tileStabilityChecks: 3, tileStabilityDelayMs: 1500 }
  };
  try {
    const existing = await BROWSER_API.storage.local.get('selectors');
    if (existing && existing.selectors && existing.selectors.version >= 1) {
      return; // déjà présent
    }
    // Charge selectors.json (fichier fourni avec l'extension) afin que l'utilisateur
    // puisse ajuster les sélecteurs SANS modifier le code.
    let selectors = EMBEDDED;
    try {
      const resp = await fetch(BROWSER_API.runtime.getURL('selectors.json'));
      if (resp.ok) selectors = await resp.json();
    } catch (e) {
      console.warn('[background] selectors.json illisible, repli embarqué', e);
    }
    await BROWSER_API.storage.local.set({ selectors });
  } catch (e) {
    console.error('[background] initSelectors failed', e);
  }
}

// --- Gestionnaire de messages ---
BROWSER_API.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message && message.type) {
      case 'GET_SELECTORS':
        return { ok: true, value: await getSelectors() };

      case 'DOWNLOAD_MEDIA':
        return await downloadMedia(message.url, message.filename, message.folder);

      case 'SEND_TO_CONTENT': {
        // Relaie un message vers le content script d'un onglet donné.
        const resp = await sendToTab(message.tabId, message.payload);
        return resp;
      }

      case 'GET_ACTIVE_FLOW_TAB': {
        // Retourne l'onglet flow.google.com actif, ou le dernier utilisé.
        try {
          const tabs = await BROWSER_API.tabs.query({ url: '*://flow.google.com/*' });
          const active = tabs.find(t => t.active);
          if (active) return { ok: true, tabId: active.id };
          const sorted = [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          if (sorted.length > 0) return { ok: true, tabId: sorted[0].id };
          return { ok: false, error: 'No flow tab found' };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      }

      default:
        return { ok: false, error: 'Unknown message type: ' + (message && message.type) };
    }
  })().then(sendResponse);
  return true; // réponse asynchrone
});

// --- Lifecycle ---
BROWSER_API.runtime.onInstalled.addListener(() => {
  initSelectors();
});

initSelectors();

console.log('[background] Flow Automation V0.1 service worker démarré');

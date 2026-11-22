/**
 * storage-manager.js
 * Persistance et récupération des données via chrome.storage.local.
 * Utilisé par : content script, background, popup (chargé en script classique).
 *
 * Interface globale exposée : window.FlowAutomation.storage
 */
(function () {
  'use strict';

  if (typeof window.FlowAutomation === 'undefined') {
    window.FlowAutomation = {};
  }

  const DEFAULTS = {
    settings: {
      model: null,          // null = défaut du site
      aspectRatio: null,    // null = défaut du site
      outputCount: null,    // null = défaut du site
      concurrentPrompts: 1, // V0.1 : toujours 1 (séquentiel)
      autoDownload: true,
      downloadFolder: 'flow-automation'
    },
    queue: null,            // état de la file, voir queue-manager.js
    results: [],            // historique des résultats
    logs: []                // dernier N logs
  };

  const MAX_LOGS = 500;
  const MAX_RESULTS = 200;

  /**
   * Lit la clé storage. Si absente, retourne la valeur par défaut.
   */
  async function get(key) {
    try {
      const obj = await chrome.storage.local.get(key);
      const val = obj[key];
      if (val !== undefined && val !== null) return val;
      if (DEFAULTS[key] !== undefined) return structuredClone(DEFAULTS[key]);
      return null;
    } catch (e) {
      console.error('[storage] get failed', key, e);
      return DEFAULTS[key] !== undefined ? structuredClone(DEFAULTS[key]) : null;
    }
  }

  /**
   * Écrit une valeur. Retourne true si succès.
   */
  async function set(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      return true;
    } catch (e) {
      console.error('[storage] set failed', key, e);
      return false;
    }
  }

  /**
   * Supprime une clé.
   */
  async function remove(key) {
    try {
      await chrome.storage.local.remove(key);
      return true;
    } catch (e) {
      console.error('[storage] remove failed', key, e);
      return false;
    }
  }

  /**
   * Ajoute un log (avec déduplication temporelle grossière).
   * Le log est stocké en mémoire + persistance limitée.
   */
  async function appendLog(level, message, data) {
    const logs = await get('logs');
    logs.push({
      level: level || 'info',
      message: String(message),
      data: data || null,
      ts: Date.now()
    });
    // borne la taille
    const trimmed = logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs;
    await set('logs', trimmed);
  }

  /**
   * Ajoute un résultat à l'historique.
   */
  async function appendResult(result) {
    const results = await get('results');
    results.push(result);
    const trimmed = results.length > MAX_RESULTS ? results.slice(-MAX_RESULTS) : results;
    await set('results', trimmed);
  }

  /**
   * Abonne aux changements de storage (callback(changes, areaName)).
   * Retourne une fonction de désabonnement.
   */
  function onChanged(callback) {
    const listener = (changes, areaName) => {
      if (areaName === 'local') callback(changes, areaName);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  window.FlowAutomation.storage = {
    DEFAULTS,
    get,
    set,
    remove,
    appendLog,
    appendResult,
    onChanged
  };
})();

/**
 * status.js
 * Logique PURE de détermination de l'état de Google Flow à partir de faits
 * collectés par le popup/background. Aucune dépendance aux API d'extension,
 * donc testable hors navigateur (voir tests/status-simulate.js).
 *
 * Exposé comme : window.FlowAutomation.status (popup/content) et
 *                require('./status.js') en Node -> global FlowAutomation.status
 *
 * Entrée de derive(input) :
 *   apiAvailable    bool   : l'API browser/chrome est-elle utilisable ?
 *   tab             null | { id, url, status }   (status = 'loading'|'complete'|...)
 *   contentPresent  bool   : le content script répond-il au PING ?
 *   injectAttempted bool   : a-t-on tenté une réinjection ?
 *   injectError     string|null
 *   pageState       null | { isFlowPage, isInProject, readyState, hasPrompt, hasSubmit, tiles }
 *   error           string|null : erreur de communication (tabs.query, sendMessage...)
 *   errorStage      string|null : 'QUERY_TABS' | 'SEND' | 'PAGE_STATE' | ...
 *
 * Sortie : { code, label, detail, level }  level ∈ 'ok'|'busy'|'warn'|'err'
 */

(function (root) {
  'use strict';

  const status = {};

  // Ordre de priorité : du plus bloquant au plus favorable.
  const STATES = {
    API_UNAVAILABLE:   { level: 'err',  label: 'API navigateur indisponible' },
    TAB_QUERY_ERROR:   { level: 'err',  label: 'Erreur de recherche des onglets' },
    NO_TAB:            { level: 'err',  label: 'Aucun onglet Google Flow ouvert' },
    NOT_FLOW:          { level: 'err',  label: 'Onglet actif ≠ Google Flow' },
    TAB_LOADING:       { level: 'busy', label: 'Page Flow en cours de chargement' },
    CONTENT_ABSENT:    { level: 'err',  label: 'Content script absent (injection échouée)' },
    CONTENT_NO_RESPONSE:{ level: 'err', label: 'Content script présent mais sans réponse' },
    TAB_COMM_ERROR:    { level: 'err',  label: 'Erreur de communication avec l\'onglet' },
    FLOW_NOT_PROJECT:  { level: 'warn', label: 'Flow détecté, mais aucun projet ouvert' },
    PROJECT_LOADING:   { level: 'busy', label: 'Projet Flow en cours d\'initialisation' },
    PROJECT_NO_PROMPT: { level: 'err',  label: 'Champ de prompt introuvable (connecté ? bon projet ?)' },
    PROMPT_NO_SUBMIT:  { level: 'warn', label: 'Champ prompt OK, bouton de génération introuvable' },
    READY:             { level: 'ok',   label: 'Prêt à générer' }
  };

  const isFlowUrl = (url) => /^https?:\/\/([a-z0-9-]+\.)*flow\.google\.com\//i.test(String(url || ''));
  const hasProject = (url) => /\/project\//.test(String(url || ''));

  status.isFlowUrl = isFlowUrl;
  status.hasProject = hasProject;
  status.STATES = STATES;

  status.derive = function (input) {
    const i = input || {};

    const make = (code, detail) => {
      const meta = STATES[code] || { level: 'err', label: code };
      return { code: code, label: meta.label, detail: detail || '', level: meta.level };
    };

    if (i.apiAvailable === false) {
      return make('API_UNAVAILABLE',
        'L\'objet browser/chrome.runtime est absent dans ce contexte.');
    }

    if (i.error && i.errorStage === 'QUERY_TABS') {
      return make('TAB_QUERY_ERROR', i.error);
    }

    if (!i.tab) {
      return make('NO_TAB', 'Ouvrez flow.google.com dans un onglet.');
    }

    const tabUrl = i.tab.url || '';
    const tabStatus = i.tab.status || 'complete';
    const loading = tabStatus !== 'complete';

    // Le content script doit être présent AVANT de pouvoir lire la page.
    if (!i.contentPresent) {
      if (!isFlowUrl(tabUrl)) return make('NOT_FLOW', 'URL détectée : ' + tabUrl);
      if (loading) return make('TAB_LOADING', 'Statut de l\'onglet : ' + tabStatus);
      if (i.injectAttempted && i.injectError) {
        return make('CONTENT_ABSENT', 'Réinjection impossible : ' + i.injectError);
      }
      if (i.error && i.errorStage === 'SEND') {
        return make('TAB_COMM_ERROR', i.error);
      }
      return make('CONTENT_ABSENT',
        'Le script de contenu ne répond pas au PING dans l\'onglet ' + (i.tab.id));
    }

    // Content script présent : on lit l'état de la page.
    if (!i.pageState) {
      return make('CONTENT_NO_RESPONSE',
        'Le content script est présent mais GET_PAGE_STATE n\'a pas répondu' +
        (i.error ? ' (' + i.error + ')' : '.'));
    }

    const ps = i.pageState;
    if (!ps.isFlowPage && !isFlowUrl(tabUrl)) {
      return make('NOT_FLOW', 'URL détectée : ' + tabUrl);
    }
    if (loading || ps.readyState === 'loading') {
      return make('TAB_LOADING', 'document.readyState = ' + (ps.readyState || tabStatus));
    }
    if (!ps.isInProject && !hasProject(tabUrl)) {
      return make('FLOW_NOT_PROJECT',
        'Ouvrez un projet (URL contenant /project/…).');
    }
    if (ps.hasAppRoot === false && ps.hasPrompt === false) {
      return make('PROJECT_LOADING', 'Application Flow non montée dans le DOM.');
    }
    if (!ps.hasPrompt) {
      return make('PROJECT_NO_PROMPT',
        'Aucun champ contenteditable détecté (êtes-vous connecté et dans un projet ?).');
    }
    if (ps.hasSubmit === false) {
      return make('PROMPT_NO_SUBMIT',
        'Le bouton de génération n\'a pas été identifié (sélecteur à valider).');
    }
    return make('READY',
      (ps.tiles || 0) + ' tuile(s) présente(s) sur la page.');
  };

  status.describe = function (result) {
    return '[' + (result.level || '?').toUpperCase() + '] ' + result.label +
      (result.detail ? ' — ' + result.detail : '');
  };

  root.FlowAutomation = root.FlowAutomation || {};
  root.FlowAutomation.status = status;

  if (typeof module !== 'undefined' && module.exports) module.exports = status;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));

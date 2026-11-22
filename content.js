/**
 * content.js
 * Content script sur flow.google.com.
 *
 * Responsabilités :
 *  - charger selectors.json et configurer flow-dom / generation-manager
 *  - exposer le pipeline d'un prompt (processPrompt) au queue-manager
 *  - relayer les messages de la popup/background
 *
 * Pipeline d'un prompt (états) :
 *   PREPARING -> (vérifs page) -> SUBMITTING -> GENERATING ->
 *   DETECTING_RESULT -> DOWNLOADING -> COMPLETED
 *   |-> ERROR / TIMEOUT / CANCELLED
 *
 * Règles de fiabilité :
 *  - Ne jamais considérer une génération terminée parce que le bouton a été
 *    cliqué ou le champ vidé.
 *  - Ne jamais déclencher une deuxième génération si la première est en cours.
 */

(function () {
  'use strict';

  // Marqueur de chargement : permet au diagnostic (getInjected) de prouver que
  // CE fichier a bien été exécuté, et non un ancien contenu corrompu/cache.
  // Il sert aussi de garde d'idempotence : si le service worker réinjecte le
  // script alors qu'il tourne déjà, on s'arrête immédiatement (pas de second
  // écouteur, pas de seconde initialisation).
  if (window.__FLOW_AUTOMATION_LOADED__) {
    console.warn('[content] déjà chargé (v' + window.__FLOW_AUTOMATION_LOADED__ + ') — réinjection ignorée');
    return;
  }
  window.__FLOW_AUTOMATION_LOADED__ = '0.1.5';

  if (typeof window.FlowAutomation === 'undefined') {
    window.FlowAutomation = {};
  }

  // Couche d'adaptation : `chrome` (Chromium / Quetta) en priorité, repli `browser`.
  const api = (typeof chrome !== 'undefined' && chrome.runtime)
    ? chrome
    : (typeof browser !== 'undefined' ? browser : null);

  const dom = window.FlowAutomation.dom;
  const generation = window.FlowAutomation.generation;
  const download = window.FlowAutomation.download;
  const queue = window.FlowAutomation.queue;
  const storage = window.FlowAutomation.storage;

  // Si une dépendance manque (ordre de chargement), on le journalise clairement
  // au lieu de planter silencieusement.
  if (!dom || !generation || !download || !queue || !storage) {
    console.error('[content] Dépendances manquantes',
      { dom: !!dom, generation: !!generation, download: !!download, queue: !!queue, storage: !!storage });
  }

  let selectorsConfig = null;

  // --- Chargement des sélecteurs ---
  async function loadSelectors() {
    try {
      const resp = await api.runtime.sendMessage({ type: 'GET_SELECTORS' });
      if (resp && resp.ok && resp.value) {
        selectorsConfig = resp.value;
        dom.setSelectors(selectorsConfig);
        if (selectorsConfig.durations) {
          generation.setConfig(selectorsConfig.durations);
        }
        storage.appendLog('info', 'Sélecteurs chargés (v' + (selectorsConfig.version || '?') + ')');
        return true;
      }
    } catch (e) {
      console.error('[content] loadSelectors failed', e);
    }
    storage.appendLog('warn', 'Sélecteurs indisponibles — utilisation des sélecteurs par défaut');
    dom.setSelectors({ selectors: {} });
    return false;
  }

  /**
   * Construit l'ensemble des faits sur la page, destiné au popup/diagnostic.
   */
  function buildPageState() {
    let snap = { count: 0, medias: [], percent: null };
    try { snap = generation.snapshot(); } catch (e) { /* DOM partiel */ }
    // Éléments interactifs visibles : indispensable pour diagnostiquer un
    // sélecteur de bouton qui ne correspond pas (on voit ce qui existe).
    let seen = [];
    let submitInfo = { level: null, hasButton: false, best: null, bestScore: null, near: [] };
    let submitDisabled = null;
    try {
      const c = dom.getSubmitButtonCandidates();
      submitInfo = {
        level: c.level,
        hasButton: !!c.button,
        best: c.button ? dom.describeElement(c.button, c.field) : null,
        bestScore: c.bestScore,
        near: (c.near || []).map((n) => Math.round(n.d) + 'px ' + dom.describeElement(n.el, c.field))
      };
      // Le bouton d'envoi est-il désactivé ? Indice décisif : si oui, la saisie
      // n'a pas été acceptée par le modèle (donc l'envoi ne fera rien).
      if (c.button) {
        submitDisabled = !!(c.button.disabled ||
          (c.button.getAttribute && c.button.getAttribute('aria-disabled') === 'true'));
      }
      seen = dom.describeInteractiveElements(60, c.field);
    } catch (e) { /* DOM partiel */ }
    let promptLen = null;
    try { promptLen = dom.getPromptText().length; } catch (e) { /* DOM partiel */ }
    return {
      url: (typeof location !== 'undefined' ? location.href : ''),
      isFlowPage: dom.isFlowPage(),
      isInProject: dom.isInProject(),
      readyState: dom.getReadyState(),
      hasAppRoot: dom.hasAppRoot(),
      hasPrompt: dom.hasPromptTextarea(),
      hasSubmit: dom.hasSubmitButton(),
      submitLevel: submitInfo.level,
      submitBest: submitInfo.best,
      submitBestScore: submitInfo.bestScore,
      submitDisabled: submitDisabled,
      promptLen: promptLen,
      nearPrompt: submitInfo.near,
      seen: seen,
      tiles: snap.count,
      medias: snap.medias.length,
      percent: snap.percent
    };
  }

  // --- Vérifications de la page ---
  function checkPage() {
    if (!dom.isFlowPage()) {
      return { ok: false, error: 'Page non reconnue comme Google Flow' };
    }
    if (!dom.hasPromptTextarea()) {
      return { ok: false, error: 'Champ de prompt introuvable — êtes-vous connecté et dans un projet ?' };
    }
    return { ok: true };
  }

  // --- Pipeline d'un prompt ---
  async function processPrompt(item, signal, log) {
    const promptText = item.prompt;

    // Vérifications de la page (WAITING_FOR_USER si problème)
    const pageCheck = checkPage();
    if (!pageCheck.ok) {
      return { status: 'WAITING_FOR_USER', error: pageCheck.error, medias: [] };
    }

    // Baseline avant soumission : état actuel des tuiles
    const baseline = generation.snapshot();
    log('info', `Baseline: ${baseline.count} tuile(s) présente(s)`);

    // 1. SUBMITTING — remplir le prompt
    item.status = 'SUBMITTING';
    queue.notify();
    log('info', 'Remplissage du prompt...');
    const filled = dom.setPromptText(promptText);
    if (!filled) {
      return { status: 'ERROR', error: 'Impossible d\'écrire dans le champ de prompt', medias: [] };
    }
    // vérifie que le texte a bien été pris en compte PAR LE MODÈLE (pas seulement
    // présent dans le DOM) : si le texte diffère, la saisie n'a pas été acceptée
    // et l'envoi ne produira rien.
    const written = dom.getPromptText();
    const accepted = written.trim() === promptText.trim();
    if (accepted) {
      log('info', 'Prompt écrit (' + written.length + ' caractère(s)) — correspond au texte attendu');
    } else {
      log('warn', 'Le texte du champ DIFFÈRE du texte attendu (' + written.length +
        ' vs ' + promptText.length + ' car.) — la saisie n\'a peut-être pas été acceptée');
    }

    // petit délai pour laisser l'UI réagir (attente de rendu, pas de détection
    // à contourner)
    await sleep(800);

    const submit = dom.submitPrompt();
    if (!submit.ok) {
      return { status: 'ERROR', error: submit.error || 'Soumission impossible', medias: [], diag: submit };
    }
    log('info', 'Soumission du prompt (voie : ' + submit.via + ')');
    if (submit.reacted) {
      log('warn', 'Le bouton d\'envoi paraît encore désactivé après remplissage.');
    }

    // 2. GENERATING — attendre la fin réelle
    item.status = 'GENERATING';
    queue.notify();
    log('info', 'Génération en cours — attente de la fin (timeout ' +
      (generation.getConfig().generationTimeoutMs / 1000) + 's)');

    const completion = await generation.waitForCompletion(baseline, signal);

    if (completion.cancelled) {
      return { status: 'CANCELLED', error: 'Annulé par l\'utilisateur', medias: [] };
    }
    if (!completion.ok) {
      if (completion.notStarted) {
        // Aucun signe de génération : on NE relance PAS automatiquement (règle de
        // fiabilité : jamais de seconde génération après un échec). On signale
        // honnêtement pour que l'utilisateur réessaie ou corrige le sélecteur.
        log('error', completion.error);
        return { status: 'ERROR', notStarted: true, error: completion.error, medias: [] };
      }
      return {
        status: completion.timeout ? 'TIMEOUT' : 'ERROR',
        error: completion.error || 'Échec de détection du résultat',
        medias: []
      };
    }

    // 3. DETECTING_RESULT
    item.status = 'DETECTING_RESULT';
    queue.notify();
    log('info', completion.medias.length + ' média(s) détecté(s)');

    if (completion.medias.length === 0) {
      return { status: 'ERROR', error: 'Aucun média détecté après génération', medias: [] };
    }

    // 4. DOWNLOADING
    item.status = 'DOWNLOADING';
    queue.notify();

    const settings = await storage.get('settings');
    const dlResult = await download.downloadMedias(completion.medias, {
      promptIndex: parseInt(item.id.replace(/^p-\d+-/, ''), 10) || 0,
      prompt: item.prompt,
      folder: settings.downloadFolder || 'flow-automation',
      verifyAccess: true
    });

    const failed = dlResult.results.filter((r) => !r.ok);
    if (failed.length > 0) {
      log('error', failed.length + ' téléchargement(s) en échec — voir historique');
      return {
        status: 'ERROR',
        error: failed.length + ' média(s) non téléchargé(s) — relance manuelle du téléchargement possible',
        medias: completion.medias
      };
    }

    log('success', 'Tous les médias téléchargés');
    return {
      status: 'COMPLETED',
      medias: completion.medias,
      downloadResults: dlResult.results
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Exposition du pipeline ---
  queue.setPipeline(processPrompt);

  // --- Diffusion de l'état de la file vers les autres contextes ---
  function broadcastQueue() {
    const st = queue.getState();
    try { api.runtime.sendMessage({ type: 'QUEUE_SNAPSHOT', value: st }).catch(() => {}); }
    catch (e) { /* popup fermée : sans conséquence */ }
  }
  queue.onChange(broadcastQueue);

  // --- Messages reçus (popup / background) ---
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message && message.type) {
      case 'CHECK_FLOW_PAGE':
        sendResponse({ ok: true, isFlowPage: dom.isFlowPage(), hasPrompt: dom.hasPromptTextarea() });
        return;

      case 'GET_INJECTED':
        // Preuve d'injection : le marqueur est posé au chargement de ce fichier.
        sendResponse({
          ok: true,
          injected: true,
          version: (typeof window !== 'undefined' && window.__FLOW_AUTOMATION_LOADED__) || '?'
        });
        return;

      case 'GET_PAGE_STATE':
        sendResponse(Object.assign({ ok: true }, buildPageState()));
        return;

      // --- Contrôles de la file ---
      case 'QUEUE_CREATE':
        queue.create(message.prompts);
        sendResponse({ ok: true });
        return;

      case 'QUEUE_START':
        queue.start();
        sendResponse({ ok: true });
        return;

      case 'QUEUE_PAUSE':
        queue.pause();
        sendResponse({ ok: true });
        return;

      case 'QUEUE_RESUME':
        queue.resume();
        sendResponse({ ok: true });
        return;

      case 'QUEUE_CANCEL':
        queue.cancel();
        sendResponse({ ok: true });
        return;

      case 'QUEUE_GET':
        sendResponse({ ok: true, value: queue.getState() });
        return;

      case 'PING':
        sendResponse({ ok: true, pong: true });
        return;

      default:
        // ne pas répondre
        return;
    }
  });

  // --- Initialisation ---
  (async function init() {
    await loadSelectors();
    // restaure la file et inspecte les éventuels prompts interrompus
    const restored = await queue.restore();
    if (restored.restored) {
      queue.inspectInterrupted(dom, generation);
      storage.appendLog('info', 'File restaurée depuis le storage');
    }
    storage.appendLog('info', 'Content script prêt');
    queue.notify();
  })();
})();
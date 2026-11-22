/**
 * queue-manager.js
 * Gestion de la file d'attente des prompts (V0.1 : exécution STRICTEMENT séquentielle).
 *
 * États d'un prompt :
 *   IDLE | PREPARING | SUBMITTING | GENERATING | DETECTING_RESULT |
 *   DOWNLOADING | COMPLETED | ERROR | TIMEOUT | CANCELLED | WAITING_FOR_USER
 *
 * Responsabilités :
 *  - exécuter les prompts un par un via le pipeline (content.js)
 *  - pause / reprise / annulation
 *  - persistance régulière dans chrome.storage.local
 *  - restauration après redémarrage SANS relancer automatiquement un prompt
 *    dont la génération était peut-être déjà en cours
 *
 * Cette couche utilise window.FlowAutomation.storage (API chrome).
 */

(function () {
  'use strict';

  if (typeof window.FlowAutomation === 'undefined') {
    window.FlowAutomation = {};
  }

  const queue = {};

  const QUEUE_KEY = 'queue';
  const STORAGE_KEY = 'results';
  const PERSIST_INTERVAL_MS = 2000;

  // --- Pipeline injecté (défini dans content.js) ---
  // processPrompt(prompt, signal, onLog) => { status, medias, error, downloadResults }
  let processPrompt = null;

  queue.setPipeline = function (fn) {
    processPrompt = fn;
  };

  // --- Structure de la file ---
  let state = {
    items: [],          // [{ id, prompt, status, error, medias, ts }]
    currentIndex: -1,   // index du prompt en cours de traitement (-1 = aucun)
    isRunning: false,
    isPaused: false,
    isCancelled: false
  };

  // --- Notification des changements ---
  const listeners = new Set();

  queue.onChange = function (fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  /**
   * Notifie les observateurs (utilisé par le pipeline pour rafraîchir l'UI
   * entre les états d'un prompt).
   */
  queue.notify = function () {
    emit();
  };

  function emit() {
    // clone léger pour éviter les mutations externes
    const snapshot = JSON.parse(JSON.stringify(state));
    for (const fn of listeners) {
      try { fn(snapshot); } catch (e) { console.error('[queue] listener error', e); }
    }
  }

  // --- API de la file ---

  /**
   * Crée une file à partir d'une liste de prompts (strings).
   * Réinitialise l'état.
   */
  queue.create = function (prompts) {
    state = {
      items: prompts.map((p, i) => ({
        id: 'p-' + Date.now() + '-' + i,
        prompt: String(p).trim(),
        status: 'IDLE',
        error: null,
        medias: [],
        ts: null
      })),
      currentIndex: -1,
      isRunning: false,
      isPaused: false,
      isCancelled: false
    };
    // retire les prompts vides
    state.items = state.items.filter((it) => it.prompt.length > 0);
    persist();
    emit();
  };

  queue.getState = function () {
    return JSON.parse(JSON.stringify(state));
  };

  /**
   * Démarre l'exécution de la file.
   */
  queue.start = async function () {
    if (state.isRunning && !state.isPaused) return;
    if (state.items.length === 0) return;
    state.isRunning = true;
    state.isPaused = false;
    state.isCancelled = false;
    persist();
    emit();
    await runLoop();
  };

  /**
   * Pause : interrompt entre deux prompts (pas en plein milieu d'une génération
   * pour éviter les états incohérents — le pipeline est atomic).
   */
  queue.pause = function () {
    if (!state.isRunning) return;
    state.isPaused = true;
    persist();
    emit();
  };

  /**
   * Reprendre.
   */
  queue.resume = function () {
    if (!state.isPaused) return;
    state.isPaused = false;
    state.isCancelled = false;
    persist();
    emit();
    runLoop(); // relance le traitement
  };

  /**
   * Annule toute la file.
   */
  queue.cancel = function () {
    state.isCancelled = true;
    state.isPaused = false;
    for (const item of state.items) {
      if (item.status === 'IDLE' || item.status === 'PREPARING' || item.status === 'SUBMITTING' ||
          item.status === 'GENERATING' || item.status === 'DETECTING_RESULT') {
        item.status = 'CANCELLED';
      }
    }
    state.currentIndex = -1;
    state.isRunning = false;
    persist();
    emit();
  };

  /**
   * Efface l'historique de la file courante.
   */
  queue.clear = function () {
    state = {
      items: [],
      currentIndex: -1,
      isRunning: false,
      isPaused: false,
      isCancelled: false
    };
    persist();
    emit();
  };

  // --- Persistance ---

  async function persist() {
    await window.FlowAutomation.storage.set(QUEUE_KEY, state);
  }

  async function saveResult(item) {
    const result = {
      prompt: item.prompt,
      status: item.status,
      error: item.error || null,
      medias: item.medias || [],
      ts: item.ts || Date.now()
    };
    await window.FlowAutomation.storage.appendResult(result);
  }

  /**
   * Restaure l'état depuis le storage.
   * Retourne { restored: bool, state }.
   */
  queue.restore = async function () {
    const saved = await window.FlowAutomation.storage.get(QUEUE_KEY);
    if (!saved || !saved.items) {
      return { restored: false, state: queue.getState() };
    }
    state = {
      items: saved.items || [],
      currentIndex: -1,          // ne reprend pas automatiquement au milieu
      isRunning: false,
      isPaused: true,            // état sûr après redémarrage
      isCancelled: false
    };
    // Marque les prompts qui étaient en cours comme "WAITING_FOR_USER" (à inspecter)
    for (const item of state.items) {
      const inProgress = ['PREPARING', 'SUBMITTING', 'GENERATING', 'DETECTING_RESULT', 'DOWNLOADING'];
      if (inProgress.indexOf(item.status) !== -1) {
        item.status = 'WAITING_FOR_USER';
        item.error = 'Interruption — vérifier la page avant de reprendre';
      }
    }
    await persist();
    emit();
    return { restored: true, state: queue.getState() };
  };

  /**
   * Marque un prompt "en attente" si la page semble avoir déjà produit un
   * résultat (utilisé après restauration, avant reprise).
   */
  queue.inspectInterrupted = function (dom, generation) {
    const interrupted = state.items.filter((it) => it.status === 'WAITING_FOR_USER');
    if (interrupted.length === 0) return;
    const baseline = generation.snapshot();
    const medias = baseline.medias;
    if (medias.length > 0) {
      // La page contient déjà des médias : on propose un traitement manuel
      for (const it of interrupted) {
        it.medias = medias;
        it.ts = Date.now();
      }
      persist();
      emit();
    }
  };

  // --- Boucle d'exécution séquentielle ---

  async function runLoop() {
    if (!state.isRunning) return;
    if (state.isPaused || state.isCancelled) return;

    // trouve le prochain prompt non terminé
    let idx = state.items.findIndex((it) => {
      return it.status === 'IDLE' || it.status === 'WAITING_FOR_USER';
    });
    // si aucun non traité mais qu'il reste des prompts en cours d'exécution
    // (cas reprise manuelle), on reprend au premier en cours.
    if (idx === -1) {
      idx = state.items.findIndex((it) => {
        return it.status === 'PREPARING' || it.status === 'SUBMITTING' ||
               it.status === 'GENERATING' || it.status === 'DETECTING_RESULT' ||
               it.status === 'DOWNLOADING';
      });
    }

    if (idx === -1) {
      // file terminée
      state.isRunning = false;
      state.currentIndex = -1;
      await persist();
      emit();
      return;
    }

    state.currentIndex = idx;
    const item = state.items[idx];
    emit();

    if (item.status === 'WAITING_FOR_USER') {
      // l'utilisateur doit confirmer : on s'arrête en attente
      state.isPaused = true;
      await persist();
      emit();
      return;
    }

    if (!processPrompt) {
      item.status = 'ERROR';
      item.error = 'Pipeline non initialisé';
      item.ts = Date.now();
      await saveResult(item);
      await persist();
      emit();
      return runLoop();
    }

    const signal = {
      cancelled: false,
      get isCancelled() { return state.isCancelled; }
    };

    item.status = 'PREPARING';
    item.error = null;
    await persist();
    emit();

    const log = (level, msg) => {
      window.FlowAutomation.storage.appendLog(level, msg, { prompt: item.prompt });
    };

    try {
      const result = await processPrompt(item, signal, log);
      item.status = result.status || 'ERROR';
      item.error = result.error || null;
      item.medias = result.medias || [];
      item.ts = Date.now();
      await saveResult(item);
    } catch (e) {
      item.status = 'ERROR';
      item.error = String(e && e.message || e);
      item.ts = Date.now();
      await saveResult(item);
    }

    if (state.isCancelled) {
      // on s'arrête proprement
      state.isRunning = false;
      state.currentIndex = -1;
      await persist();
      emit();
      return;
    }

    await persist();
    emit();

    // continue au prompt suivant (si pas en pause)
    if (!state.isPaused) {
      return runLoop();
    }
  }

  // --- Persistance périodique (filet de sécurité) ---
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    setInterval(() => {
      if (state.items.length > 0) persist();
    }, PERSIST_INTERVAL_MS);
  }

  window.FlowAutomation.queue = queue;
})();

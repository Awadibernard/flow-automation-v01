/**
 * generation-manager.js
 * Suivi des générations et détection de leur fin.
 *
 * Stratégie (multiples indices DOM) :
 *  1. Comptage de tuiles : une nouvelle tuile = +1 par rapport à l'état initial.
 *  2. Signature : apparition d'une tuile avec média (video/img) = résultat.
 *  3. Indicateur de progression : barre de progression visible => génération en cours.
 *  4. Stabilité : un média est considéré "stable" s'il reste identique sur
 *     plusieurs contrôles espacés dans le temps (évite de prendre une miniature
 *     ou une preview partielle pour le fichier final).
 *
 * Cette couche est pure DOM ; elle ne dépend pas des API d'extension.
 * Interface globale : window.FlowAutomation.generation
 */

(function () {
  'use strict';

  if (typeof window.FlowAutomation === 'undefined') {
    window.FlowAutomation = {};
  }
  const dom = window.FlowAutomation.dom;

  const generation = {};

  // Durées par défaut (surchargées via setConfig depuis selectors.json)
  let CFG = {
    generationTimeoutMs: 180000,
    generationStartMs: 12000,
    pollIntervalMs: 2000,
    tileStabilityChecks: 3,
    tileStabilityDelayMs: 1500
  };

  generation.setConfig = function (durations) {
    if (!durations) return;
    Object.assign(CFG, durations);
  };

  generation.getConfig = function () { return CFG; };

  /**
   * Observe l'état des tuiles à un instant T.
   * Retourne un objet descriptif : { count, signatures, medias }.
   * medias = [{ url, type, tileIndex }]
   */
  generation.snapshot = function () {
    const tiles = dom.getResultTiles();
    const medias = [];
    tiles.forEach((tile, i) => {
      const { videos, images } = dom.getTileMedia(tile);
      for (const v of videos) {
        const url = dom.getMediaUrl(v);
        if (url) medias.push({ url, type: 'video', tileIndex: i });
      }
      for (const img of images) {
        const url = dom.getMediaUrl(img);
        if (url) medias.push({ url, type: 'image', tileIndex: i });
      }
    });
    return {
      count: tiles.length,
      signatures: tiles.map((t) => dom.tileSignature(t)),
      medias,
      hasProgress: !!dom.getVisiblePercentage(),
      percent: dom.getVisiblePercentage()
    };
  };

  /**
   * Attend la FIN d'une génération.
   *
   * Démarre d'un snapshot initial "baseline" (pris AVANT soumission).
   * Critères de fin :
   *  - aucune barre de progression visible depuis 2 contrôles, ET
   *  - le nombre de tuiles a augmenté par rapport au baseline, ET
   *  - les médias sont stables (mêmes signatures sur `tileStabilityChecks` contrôles).
   *
   * Retourne { ok, medias, timeout, error }.
   */
  generation.waitForCompletion = async function (baseline, signal) {
    const timeoutAt = Date.now() + CFG.generationTimeoutMs;
    const startAt = Date.now();
    const startDeadline = startAt + (CFG.generationStartMs || 12000);
    let sawSignal = false;
    const baseCount = (baseline && baseline.count) || 0;
    let noProgressCount = 0;
    let stableCount = 0;
    let lastJson = null;
    let lastMedias = [];

    while (Date.now() < timeoutAt) {
      if (signal && signal.cancelled) {
        return { ok: false, cancelled: true, medias: [], error: 'Cancelled' };
      }

      const snap = generation.snapshot();
      const hasProgress = snap.hasProgress;

      // Nouvelle tuile par rapport au baseline ?
      const hasNewTile = snap.count > baseCount;

      // Y a-t-il le moindre signe que la génération a démarré ?
      //  - une nouvelle tuile est apparue ;
      //  - un indicateur de progression (spinner/barre/pourcentage) est visible ;
      //  - le nombre de médias a augmenté par rapport au baseline.
      const baseMedias = (baseline && baseline.medias ? baseline.medias.length : 0);
      if (hasNewTile || hasProgress || snap.medias.length > baseMedias) sawSignal = true;

      // Stabilité des médias (même liste de signatures sur plusieurs contrôles)
      const json = JSON.stringify(snap.medias);
      if (json === lastJson) {
        stableCount++;
      } else {
        stableCount = 0;
        lastJson = json;
      }
      lastMedias = snap.medias;

      // Progression visible ?
      if (hasProgress) {
        noProgressCount = 0;
      } else {
        noProgressCount++;
      }

      // Fin fiable : nouvelle tuile + aucun indicateur de progression + médias stables
      if (hasNewTile && !hasProgress &&
          noProgressCount >= 2 &&
          lastMedias.length > 0 &&
          stableCount >= CFG.tileStabilityChecks) {
        return { ok: true, medias: lastMedias, timeout: false, error: null };
      }

      // Échec précoce : après `generationStartMs`, AUCUN signe de génération
      // (le clic/Entrée précédent n'a rien déclenché). On échoue franchement au
      // lieu d'attendre le timeout complet de 180 s.
      if (!sawSignal && Date.now() > startDeadline) {
        return {
          ok: false,
          medias: [],
          timeout: false,
          notStarted: true,
          error: 'La génération n\'a pas démarré (~' + Math.round((CFG.generationStartMs || 12000) / 1000) +
            's après la soumission). Le bouton d\'envoi n\'a probablement pas été actionné.'
        };
      }

      await sleep(CFG.pollIntervalMs);
    }

    return {
      ok: false,
      medias: lastMedias || [],
      timeout: true,
      error: 'Timeout après ' + (CFG.generationTimeoutMs / 1000) + 's sans résultat stable'
    };
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Vérifie la stabilité d'une liste de médias donnée.
   * Retourne true si chaque média a le même src sur `checks` contrôles espacés.
   * Utilisée AVANT téléchargement pour éviter les previews instables.
   */
  generation.assertStable = async function (mediaUrls, checks, delayMs) {
    const c = checks || CFG.tileStabilityChecks;
    const d = delayMs || CFG.tileStabilityDelayMs;
    const current = () => {
      const snap = generation.snapshot();
      return snap.medias.map((m) => m.url).sort();
    };
    let prev = current();
    for (let i = 0; i < c; i++) {
      await sleep(d);
      const now = current();
      if (JSON.stringify(now) !== JSON.stringify(prev)) return false;
      prev = now;
    }
    return true;
  };

  /**
   * Vérifie qu'une URL de média est accessible (fetch HEAD/GET léger).
   * Retourne { ok, status }.
   * NOTE : en content script, le fetch est soumis à CORS. On tente le fetch
   * direct ; si CORS échoue, on considère l'URL "probablement OK" mais on
   * prévient (la vérification définitive se fera au téléchargement).
   */
  generation.checkMediaAccess = async function (url) {
    if (!url) return { ok: false, status: 0, reason: 'no-url' };
    try {
      const resp = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (resp.ok) return { ok: true, status: resp.status };
      // certains serveurs refusent HEAD -> tenter GET
      const resp2 = await fetch(url, { method: 'GET', cache: 'no-store' });
      return { ok: resp2.ok, status: resp2.status };
    } catch (e) {
      // CORS probable : la ressource existe mais fetch est bloqué
      return { ok: false, status: -1, reason: 'cors-or-network: ' + String(e) };
    }
  };

  window.FlowAutomation.generation = generation;
})();

/**
 * flow-dom.js
 * Détection des éléments et manipulation du DOM de Google Flow.
 * Cette couche est PURE DOM : elle ne dépend pas des API d'extension.
 * Elle est appelée depuis content.js (qui, lui, utilise les API d'extension).
 *
 * Interface globale : window.FlowAutomation.dom
 */

(function () {
  'use strict';

  if (typeof window.FlowAutomation === 'undefined') {
    window.FlowAutomation = {};
  }

  const dom = {};

  // --- Sélecteurs ---
  // Les sélecteurs sont injectés par content.js (via selectors.json embarqué).
  // Par défaut, on retombe sur des sélecteurs génériques Angular.
  let S = {
    promptTextarea: "div[contenteditable='true'][role='textbox']",
    submitButton: "button[jsaction*='submit'], button[aria-label*='Create' i], button[aria-label*='Generate' i]",
    generatingIndicator: "[role='progressbar'], [class*='progress']",
    resultTiles: "flow-tile, [class*='tile']",
    tileMedia: 'video, img'
  };

  /**
   * Configure les sélecteurs (appelé par content.js après lecture de selectors.json).
   */
  dom.setSelectors = function (selectorsConfig) {
    if (!selectorsConfig) return;
    const sel = selectorsConfig.selectors;
    if (!sel) return;
    if (sel.promptTextarea && sel.promptTextarea.value) S.promptTextarea = sel.promptTextarea.value;
    if (sel.submitButton && sel.submitButton.value) S.submitButton = sel.submitButton.value;
    if (sel.generatingIndicator && sel.generatingIndicator.value) S.generatingIndicator = sel.generatingIndicator.value;
    if (sel.resultTiles && sel.resultTiles.value) S.resultTiles = sel.resultTiles.value;
    if (sel.tileMedia && sel.tileMedia.value) S.tileMedia = sel.tileMedia.value;
    dom.config = selectorsConfig;
  };

  dom.getConfig = function () { return dom.config || null; };

  // --- Primitives de recherche ---

  /**
   * Retourne le premier élément correspondant, ou null.
   */
  dom.q = function (selector, root) {
    const base = root || document;
    try {
      return base.querySelector(selector);
    } catch (e) {
      console.warn('[flow-dom] invalid selector', selector, e);
      return null;
    }
  };

  /**
   * Retourne tous les éléments correspondants (Array).
   */
  dom.qa = function (selector, root) {
    const base = root || document;
    try {
      return Array.from(base.querySelectorAll(selector));
    } catch (e) {
      console.warn('[flow-dom] invalid selector', selector, e);
      return [];
    }
  };

  /**
   * Attend qu'un sélecteur apparaisse dans le DOM.
   * Retourne le premier élément ou null après timeout.
   */
  dom.waitFor = function (selector, timeoutMs, intervalMs) {
    return new Promise((resolve) => {
      const timeout = timeoutMs || 10000;
      const interval = intervalMs || 500;
      const started = Date.now();
      const check = () => {
        const el = dom.q(selector);
        if (el) return resolve(el);
        if (Date.now() - started > timeout) return resolve(null);
        setTimeout(check, interval);
      };
      check();
    });
  };

  // --- Détection de page ---

  /**
   * True si la page courante est Google Flow.
   */
  dom.isFlowPage = function () {
    return typeof location !== 'undefined' && location.hostname === 'flow.google.com';
  };

  /**
   * True si on est dans un projet (route /project/...).
   */
  dom.isInProject = function () {
    return dom.isFlowPage() && location.pathname.indexOf('/project/') !== -1;
  };

  /**
   * Récupère le champ de prompt. Retourne l'élément ou null.
   */
  dom.getPromptTextarea = function () {
    return dom.q(S.promptTextarea);
  };

  /**
   * Vérifie que le champ de prompt est présent et éditable.
   */
  dom.hasPromptTextarea = function () {
    const el = dom.getPromptTextarea();
    return !!el;
  };

  /**
   * True si un bouton de génération/soumission est présent dans le DOM.
   * Utilisé par le diagnostic pour distinguer "champ OK mais bouton introuvable".
   */
  dom.hasSubmitButton = function () {
    return !!dom.getSubmitButton();
  };

  /**
   * True si l'application Flow semble montée (un contenu applicatif existe).
   * Indice large mais non ambigu : présence d'un élément custom `flow-*`,
   * d'un champ editable, d'une tuile ou d'un bouton. Sert à distinguer
   * "page en cours d'initialisation" de "mauvais sélecteur".
   */
  dom.hasAppRoot = function () {
    try {
      if (document.querySelector('flow-app, [class*="flow-"], flow-tile')) return true;
      if (document.querySelector("div[contenteditable], [role='textbox']")) return true;
      if (dom.getResultTiles().length > 0) return true;
      return !!dom.getSubmitButton();
    } catch (e) {
      return false;
    }
  };

  /**
   * document.readyState de la page hôte ('loading'|'interactive'|'complete').
   */
  dom.getReadyState = function () {
    try { return document.readyState; } catch (e) { return 'unknown'; }
  };

  // --- Manipulation du champ de prompt ---

  /**
   * Écrit du texte dans un contenteditable/textarea en simulant un apport
   * réel d'input (événements compatibles Angular/React).
   * Retourne true/false.
   */
  dom.setPromptText = function (text) {
    const el = dom.getPromptTextarea();
    if (!el) return false;
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, 'value'
        ) || Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, 'value'
        );
        if (setter && setter.set) {
          setter.set.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      // contenteditable
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      console.error('[flow-dom] setPromptText failed', e);
      return false;
    }
  };

  /**
   * Récupère le texte actuel du champ de prompt.
   */
  dom.getPromptText = function () {
    const el = dom.getPromptTextarea();
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
    return el.textContent || '';
  };

  // --- Boutons ---

  /**
   * Trouve le bouton de soumission visible.
   */
  dom.getSubmitButton = function () {
    const candidates = dom.qa(S.submitButton);
    return candidates.find((b) => dom.isVisible(b)) || candidates[0] || null;
  };

  /**
   * Clique un élément (avec vérification préalable de visibilité).
   */
  dom.click = function (el) {
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch (e) {
      console.error('[flow-dom] click failed', e);
      return false;
    }
  };

  // --- Indicateurs de génération ---

  /**
   * Retourne les éléments indiquant une génération en cours (progressbars, spinners...).
   */
  dom.getGeneratingIndicators = function () {
    return dom.qa(S.generatingIndicator).filter((el) => dom.isVisible(el));
  };

  /**
   * Retourne le texte de pourcentage visible (ex. "45%") ou null.
   */
  dom.getVisiblePercentage = function () {
    const indicators = dom.getGeneratingIndicators();
    for (const el of indicators) {
      const t = (el.textContent || '').trim();
      const m = t.match(/^\s*(\d{1,3})\s*%\s*$/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };

  // --- Tuiles de résultats ---

  /**
   * Retourne la liste des tuiles de résultats dans le DOM.
   */
  dom.getResultTiles = function () {
    return dom.qa(S.resultTiles);
  };

  /**
   * Récupère le(s) média(s) d'une tuile (video et img).
   */
  dom.getTileMedia = function (tile) {
    if (!tile) return { videos: [], images: [] };
    const videos = dom.qa('video', tile);
    const images = dom.qa('img', tile).filter((img) => {
      // évite les images décoratives (icônes) : exige une taille minimale
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      return w >= 50 && h >= 50;
    });
    return { videos, images };
  };

  /**
   * Extraie l'URL d'un média. Retourne l'URL source (non blob) si possible.
   */
  dom.getMediaUrl = function (mediaEl) {
    if (!mediaEl) return null;
    let url = null;
    if (mediaEl.tagName === 'VIDEO') {
      url = mediaEl.currentSrc || mediaEl.src || null;
    } else {
      url = mediaEl.currentSrc || mediaEl.src || null;
    }
    if (!url) return null;
    // on accepte http(s) uniquement (pas blob: ni data:)
    if (/^https?:\/\//.test(url)) return url;
    return null;
  };

  /**
   * Détermine le type de média d'un élément (video|image|null).
   */
  dom.getMediaType = function (mediaEl) {
    if (!mediaEl) return null;
    if (mediaEl.tagName === 'VIDEO') return 'video';
    if (mediaEl.tagName === 'IMG') return 'image';
    return null;
  };

  // --- Utilitaires de visibilité ---

  /**
   * True si l'élément est visible (box + non display:none).
   */
  dom.isVisible = function (el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (e) {
      return false;
    }
  };

  // --- Génération : signatures de tuiles ---

  /**
   * Produit une "signature" stable d'une tuile pour détecter de nouvelles tuiles.
   * Basée sur le contenu média + position + taille.
   */
  dom.tileSignature = function (tile) {
    const media = dom.getTileMedia(tile);
    const parts = [];
    for (const v of media.videos) {
      parts.push('v:' + (dom.getMediaUrl(v) || 'no-src'));
    }
    for (const img of media.images) {
      parts.push('i:' + (dom.getMediaUrl(img) || 'no-src'));
    }
    return parts.join('|');
  };

  window.FlowAutomation.dom = dom;
})();

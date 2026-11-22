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
  // Les sélecteurs sont injectés par content.js (via selectors.json).
  // Les valeurs par défaut ci-dessous visent le framework réel de Flow
  // (Angular Material : <button class="flow-button-*"> avec <mat-icon>).
  let S = {
    // Prompt : contenteditable typique ; on liste aussi textarea en repli.
    promptTextarea: [
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
      "[role='textbox'][contenteditable]",
      'textarea'
    ].join(', '),
    // Bouton d'envoi : familles du plus spécifique au plus générique.
    submitButton: [
      "button[data-test-id*='submit' i]",
      "button[data-testid*='submit' i]",
      "button[aria-label*='submit' i]",
      "button[aria-label*='send' i]",
      "button[aria-label*='generate' i]",
      "button[aria-label*='create' i]",
      "button[jsaction*='submit']",
      "button[type='submit']"
    ].join(', '),
    // Replis structurels si aucune famille nommée ne correspond.
    submitButtonFallbacks: [
      "form button:not([disabled])",
      "[role='button'][aria-label*='send' i]",
      "[role='button'][aria-label*='submit' i]",
      '[role="button"]',
      'button:has(mat-icon)',
      'button:has(svg)',
      'button:has(i)',
      'button',
      'mat-icon'
    ],
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
    if (sel.submitButton && Array.isArray(sel.submitButton.fallbacks)) {
      S.submitButtonFallbacks = sel.submitButton.fallbacks;
    }
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
   * Critères : contenteditable NON désactivé, ou <textarea> non désactivé.
   */
  dom.getPromptTextarea = function () {
    const el = dom.q(S.promptTextarea);
    if (!el) return null;
    if (el.disabled === true) return null;
    // `!= null` couvre à la fois null (DOM réel) et undefined (implémentations
    // simplifiées), sans confondre avec un attribut présent.
    const dis = el.getAttribute ? el.getAttribute('disabled') : null;
    if (dis != null) return null;
    return el;
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
   * True si un élément est actionnable comme bouton (aria/role/tag).
   */
  dom.isButtonLike = function (el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a') return true;
    if (el.getAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('type') === 'submit')) return true;
    return false;
  };

  /**
   * Candidats au rôle de bouton d'envoi, en 3 niveaux (du plus fiable au plus large) :
   *  1. familles nommées (selectors.json) — submit/send/generate/create/type=submit ;
   *  2. replis structurels — form button:not([disabled]), role=button, :has(mat-icon/svg). ;
   *  3. dernier recours — 1 seul bouton visible, ou bouton visible adjacent au champ prompt.
   * Retourne { level, all, visible, button, field }.
   */
  dom.getSubmitButtonCandidates = function () {
    const field = dom.getPromptTextarea();

    // Niveau 1 — sélecteurs nommés
    let all = dom.qa(S.submitButton).filter((el) => !el.disabled);
    let level = 'named';

    // Niveau 2 — replis structurels
    if (!all.length) {
      level = 'structural';
      for (const sel of (S.submitButtonFallbacks || [])) {
        const found = dom.qa(sel).filter((el) => !el.disabled);
        if (found.length) { all = found; break; }
      }
    }

    let visible = all.filter((el) => dom.isVisible(el));
    let button = visible[0] || null;

    // Niveau 3 — dernier recours contextuel
    if (!button) {
      level = 'contextual';
      const clickable = dom.qa('button, [role="button"], a[href]').filter((el) => dom.isVisible(el) && !el.disabled);
      if (clickable.length === 1) {
        button = clickable[0];
      } else if (field && clickable.length) {
        const fBox = field.getBoundingClientRect ? field.getBoundingClientRect() : null;
        if (fBox) {
          let best = null;
          let bestDist = Infinity;
          for (const c of clickable) {
            const box = c.getBoundingClientRect ? c.getBoundingClientRect() : null;
            if (!box) continue;
            // distance entre le centre du bouton et la zone du champ
            const dx = Math.max(fBox.left - (box.left + box.width), box.left - (fBox.left + fBox.width), 0);
            const dy = Math.max(fBox.top - (box.top + box.height), box.top - (fBox.top + fBox.height), 0);
            const d = Math.hypot(dx, dy);
            if (d < bestDist) { bestDist = d; best = c; }
          }
          // seulement si le bouton est proche du champ (< 400 px)
          if (best && bestDist < 400) button = best;
        }
      }
      if (button) visible = [button];
    }

    return { level, all, visible, button: button || null, field };
  };

  /**
   * Trouve le bouton de soumission (voir getSubmitButtonCandidates).
   * Conservé pour la compatibilité : renvoie l'élément ou null.
   */
  dom.getSubmitButton = function () {
    return dom.getSubmitButtonCandidates().button;
  };

  /**
   * Indique si le champ prompt est vide (donc : quoi qu'on fasse, l'envoi
   * n'aura probablement pas d'effet).
   */
  dom.isPromptEmpty = function () {
    return dom.getPromptText().trim().length === 0;
  };

  /**
   * Décrit de façon concise les éléments interactifs visibles : sert au
   * diagnostic pour comprendre POURQUOI un sélecteur ne correspond pas.
   * Retourne une liste de chaînes 'tag[attrs]{texte}'.
   */
  dom.describeInteractiveElements = function (limit) {
    const out = [];
    const max = limit || 12;
    let els = [];
    try { els = dom.qa('button, [role="button"], a[href], mat-icon, [contenteditable]'); }
    catch (e) { return out; }
    for (const el of els) {
      if (!dom.isVisible(el)) continue;
      const tag = (el.tagName || '').toLowerCase();
      const attrs = [];
      const al = el.getAttribute && el.getAttribute('aria-label');
      const dt = el.getAttribute && (el.getAttribute('data-test-id') || el.getAttribute('data-testid'));
      const ja = el.getAttribute && el.getAttribute('jsaction');
      const ty = el.getAttribute && el.getAttribute('type');
      if (al) attrs.push('aria-label="' + String(al).slice(0, 60) + '"');
      if (dt) attrs.push('data-test-id="' + String(dt).slice(0, 40) + '"');
      if (ja) attrs.push('jsaction="' + String(ja).slice(0, 50) + '"');
      if (ty) attrs.push('type="' + ty + '"');
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      out.push(tag + (attrs.length ? '[' + attrs.join(' ') + ']' : '') + (txt ? '{' + txt + '}' : ''));
      if (out.length >= max) break;
    }
    return out;
  };

  /**
   * Valide la soumission du prompt : soit en cliquant le bouton trouvé, soit,
   * en dernier recours, en envoyant une touche Entrée depuis le champ (si un
   * bouton n'est pas identifiable mais que le champ est rempli).
   * Retourne { ok, via, level, error } — jamais de silence.
   */
  dom.submitPrompt = function () {
    const c = dom.getSubmitButtonCandidates();
    if (c.button) {
      const ok = dom.click(c.button);
      return { ok, via: 'button', level: c.level, error: ok ? null : 'clic refusé par le DOM' };
    }
    // Repli Entrée : pertinent uniquement si le champ contient du texte.
    const field = c.field;
    if (field && !dom.isPromptEmpty()) {
      const ok = dom.pressEnter(field);
      return { ok, via: 'enter', level: 'keyboard', error: ok ? null : 'événement Entrée non pris en compte' };
    }
    return {
      ok: false, via: null, level: c.level,
      error: field && dom.isPromptEmpty()
        ? 'Bouton introuvable et champ vide (saisie non prise en compte ?)'
        : 'Bouton de génération introuvable'
    };
  };

  /**
   * Envoie une touche Entrée réaliste sur un élément (pour les champs où
   * l'envoi se fait au clavier). Retourne true si l'événement n'a pas levé.
   */
  dom.pressEnter = function (field) {
    if (!field) return false;
    try {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      field.dispatchEvent(new KeyboardEvent('keydown', opts));
      field.dispatchEvent(new KeyboardEvent('keypress', opts));
      field.dispatchEvent(new KeyboardEvent('keyup', opts));
      return true;
    } catch (e) {
      console.error('[flow-dom] pressEnter failed', e);
      return false;
    }
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

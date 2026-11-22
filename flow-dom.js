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
   *
   * Pour un contenteditable, la simple affectation de `textContent` NE suffit
   * PAS : les éditeurs riches (Angular) écoutent `beforeinput`/`input` avec
   * `inputType` et `data` pour valider leur modèle. On privilégie donc une
   * saisie « réelle » via `execCommand('insertText')` (qui produit un vrai
   * InputEvent), avec repli manuel + InputEvent explicite.
   *
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

      // --- contenteditable ---
      el.focus();

      // 1) Saisie « réelle » : sélectionne tout le contenu puis insère le texte.
      //    execCommand('insertText') génère un InputEvent que les frameworks
      //    interprètent comme une frappe utilisateur.
      let usedExec = false;
      try {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        usedExec = document.execCommand && document.execCommand('insertText', false, text) === true;
      } catch (e) {
        usedExec = false;
      }

      // 2) Repli manuel : affecte le texte puis émet beforeinput + input avec
      //    inputType/data explicites (indispensable pour Angular).
      if (!usedExec) {
        el.textContent = text;
        try {
          el.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true, cancelable: true, inputType: 'insertText', data: text
          }));
        } catch (e2) {
          el.dispatchEvent(new Event('beforeinput', { bubbles: true }));
        }
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: false, inputType: 'insertText', data: text
          }));
        } catch (e2) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
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

  // Rayon (px) au-delà duquel un bouton n'est plus considéré « proche du champ ».
  const NEAR_PX = 400;

  /**
   * Nom d'icône lisible d'un élément (texte court de <mat-icon>, ex. 'send',
   * 'arrow_forward'). Retourne '' si le contenu n'est pas un nom d'icône.
   */
  dom.getIconName = function (el) {
    if (!el) return '';
    const t = (el.textContent || '').trim();
    return /^[a-z0-9_]{2,40}$/i.test(t) ? t.toLowerCase() : '';
  };

  /**
   * Libellé exploitable d'un bouton : aria-label, title, data-test-id, texte,
   * puis nom d'icône interne. Tout en minuscules.
   */
  dom.getButtonLabel = function (el) {
    if (!el) return '';
    const g = (k) => ((el.getAttribute && el.getAttribute(k)) || '');
    const inner = el.querySelector ? el.querySelector('mat-icon') : null;
    return [g('aria-label'), g('title'), g('data-test-id') || g('data-testid'),
      (el.textContent || '').trim(), dom.getIconName(inner)]
      .filter(Boolean).join(' ').toLowerCase();
  };

  /**
   * Distance minimale (px) entre un élément et la zone du champ de prompt.
   * Infinity si la géométrie n'est pas disponible.
   */
  function distanceToField(el, field) {
    if (!el || !field || !el.getBoundingClientRect || !field.getBoundingClientRect) return Infinity;
    const b = el.getBoundingClientRect();
    const f = field.getBoundingClientRect();
    if (!b || !f || (!b.width && !b.height)) return Infinity;
    const dx = Math.max(f.left - (b.left + b.width), b.left - (f.left + f.width), 0);
    const dy = Math.max(f.top - (b.top + b.height), b.top - (f.top + f.height), 0);
    return Math.hypot(dx, dy);
  }

  /**
   * Score d'un candidat comme bouton d'ENVOI du prompt.
   * Rapproche : libellé (send/submit/arrow/enter...), nom d'icône, position
   * (à droite du champ, dans sa bande verticale), proximité ; éloigne les
   * boutons de barre d'outils (add/search/filter/help/home/more/...).
   */
  dom.scoreSubmitCandidate = function (el, field) {
    if (!el) return -Infinity;
    const label = dom.getButtonLabel(el);
    const icon = dom.getIconName(el.querySelector ? el.querySelector('mat-icon') : null);
    let s = 0;

    if (/send|submit|arrow|enter|prompt|generate|envoyer|créer|creer/i.test(label)) s += 3;
    if (/send|arrow|enter|submit/i.test(icon)) s += 3;

    if (field && el.getBoundingClientRect && field.getBoundingClientRect) {
      const b = el.getBoundingClientRect();
      const f = field.getBoundingClientRect();
      if (b && f && (b.width || b.height)) {
        if (b.left >= f.right - 8) s += 2;                // à droite du champ
        if (b.bottom > f.top && b.top < f.bottom) s += 1; // dans la bande du champ
        const d = distanceToField(el, field);
        if (d < 120) s += 2; else if (d < NEAR_PX) s += 1;
      }
    }

    if (/add|search|filter|help|home|more|menu|back|close|expand|settings|delete|supprimer|share|download|filtre|accueil|rechercher/i.test(label)) s -= 3;
    if (el.disabled) s -= 5;
    return s;
  };

  /**
   * Candidats au rôle de bouton d'envoi.
   *
   * On construit un ENSEMBLE candidat = (sélecteurs nommés) ∪ (replis
   * structurels) ∪ (éléments cliquables visibles proches du champ prompt), puis
   * on retient celui de **meilleur score** (voir scoreSubmitCandidate).
   *
   * Pourquoi une union et pas un simple « premier sélecteur non vide » : le
   * bouton d'envoi réel peut ne porter aucun libellé connnu, tandis qu'un autre
   * bouton (ex. « Accueil », « Ajouter ») correspond à un sélecteur nommé. Sans
   * union, ce dernier détournerait l'envoi — c'est exactement le bug observé.
   *
   * Retourne { level, all, visible, button, field, bestScore, near }.
   */
  dom.getSubmitButtonCandidates = function () {
    const field = dom.getPromptTextarea();

    // 1. sélecteurs nommés
    const named = dom.qa(S.submitButton).filter((el) => !el.disabled);

    // 2. replis structurels (seulement si aucun nommé)
    let structural = [];
    if (!named.length) {
      for (const sel of (S.submitButtonFallbacks || [])) {
        const found = dom.qa(sel).filter((el) => !el.disabled);
        if (found.length) { structural = found; break; }
      }
    }

    const level = named.length ? 'named' : (structural.length ? 'structural' : 'contextual');

    // 3. éléments cliquables visibles autour du champ prompt
    const clickable = dom.qa('button, [role="button"], a[href]')
      .filter((el) => dom.isVisible(el) && !el.disabled);
    let near = [];
    if (field) {
      near = clickable
        .map((el) => ({ el, d: distanceToField(el, field) }))
        .filter((x) => x.d < NEAR_PX)
        .sort((a, b) => a.d - b.d);
    }

    // Ensemble candidat (dédupliqué)
    const set = new Set();
    const addVisible = (arr) => (arr || []).forEach((el) => { if (el && dom.isVisible(el)) set.add(el); });
    addVisible(named);
    addVisible(structural);
    near.forEach((x) => set.add(x.el));

    let candidates = Array.from(set);
    // Dernier recours : tous les cliquables visibles, sinon nommés/structurels.
    if (!candidates.length) {
      candidates = clickable.length ? clickable : (named.length ? named : structural);
    }

    // Sélection par score (meilleur candidat)
    let button = null;
    let bestScore = null;
    if (candidates.length) {
      const scored = candidates
        .map((el) => ({ el, score: dom.scoreSubmitCandidate(el, field) }))
        .sort((a, b) => b.score - a.score);
      button = scored[0].el;
      bestScore = scored[0].score;
    }

    const visible = candidates.filter((el) => dom.isVisible(el));

    return { level, all: named.concat(structural), visible, button: button || null, field, bestScore, near: near.slice(0, 8) };
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
   * Décrit un élément en une chaîne 'tag[attrs]{texte}'. Le champ prompt est
   * marqué « <<< PROMPT ». Utilisé par le diagnostic.
   */
  dom.describeElement = function (el, field) {
    if (!el) return '';
    const f = field || dom.getPromptTextarea();
    const tag = (el.tagName || '').toLowerCase();
    const attrs = [];
    const al = el.getAttribute && el.getAttribute('aria-label');
    const dt = el.getAttribute && (el.getAttribute('data-test-id') || el.getAttribute('data-testid'));
    const ja = el.getAttribute && el.getAttribute('jsaction');
    const ty = el.getAttribute && el.getAttribute('type');
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (al) attrs.push('aria-label="' + String(al).slice(0, 60) + '"');
    if (dt) attrs.push('data-test-id="' + String(dt).slice(0, 40) + '"');
    if (ja) attrs.push('jsaction="' + String(ja).slice(0, 50) + '"');
    if (ty) attrs.push('type="' + ty + '"');
    if (ph) attrs.push('placeholder="' + String(ph).slice(0, 40) + '"');
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const isField = (el === f) ||
      (el.getAttribute && el.getAttribute('contenteditable') === 'true');
    return tag + (attrs.length ? '[' + attrs.join(' ') + ']' : '') +
      (txt ? '{' + txt + '}' : '') + (isField ? '   <<< PROMPT' : '');
  };

  /**
   * Décrit de façon concise les éléments interactifs visibles : sert au
   * diagnostic pour comprendre POURQUOI un sélecteur ne correspond pas et
   * pour repérer le bouton d'envoi réel. Retourne une liste de chaînes.
   */
  dom.describeInteractiveElements = function (limit, field) {
    const out = [];
    const max = limit || 60;
    const f = field || dom.getPromptTextarea();
    let els = [];
    try { els = dom.qa('button, [role="button"], a[href], mat-icon, input, textarea, [contenteditable]'); }
    catch (e) { return out; }
    for (const el of els) {
      if (!dom.isVisible(el)) continue;
      out.push(dom.describeElement(el, f));
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
      // UNE seule activation (voir dom.click) : la séquence souris complète est
      // dispatchée, puis `el.click()` natif déclenche l'action par défaut du
      // bouton (`type=submit` → soumission réelle du formulaire), ce qu'un
      // MouseEvent synthétique ne fait PAS. On NE presse PAS Entrée ici : cela
      // pourrait déclencher une seconde génération. Le repli Entrée est décidé
      // par l'appelant (content.js) uniquement si le clic n'a produit aucun signe.
      const ok = dom.click(c.button);
      const reacted = !!(c.button.disabled ||
        (c.button.getAttribute && c.button.getAttribute('aria-disabled') === 'true'));
      return { ok, via: 'button', level: c.level, reacted, button: c.button, field: c.field, error: ok ? null : 'bouton non actionnable' };
    }
    // Repli Entrée : pertinent uniquement si le champ contient du texte.
    const field = c.field;
    if (field && !dom.isPromptEmpty()) {
      const ok = dom.pressEnter(field);
      return { ok, via: 'enter', level: 'keyboard', reacted: false, field, error: ok ? null : 'événement Entrée non pris en compte' };
    }
    return {
      ok: false, via: null, level: c.level, reacted: false,
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
   * Active un élément avec UNE seule activation :
   *  - on rejoue le geste souris (pointerdown/mousedown/pointerup/mouseup) dont
   *    dépendent certains composants Angular Material (ripple/gesture) ;
   *  - puis on appelle `el.click()` NATIF : il émet UN seul événement `click`
   *    (qui déclenche le listener Angular) ET l'action par défaut du bouton
   *    (`type=submit` → soumission réelle), ce qu'un MouseEvent synthétique ne
   *    fait pas. Comme `el.click()` fournit déjà l'événement `click`, on
   *    n'en dispatche PAS un second (sinon le handler s'exécuterait deux fois).
   */
  dom.click = function (el) {
    if (!el) return false;
    try {
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) { /* ancien moteur */ }
      try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) { /* ancien moteur */ }
      try { el.focus && el.focus(); } catch (e) { /* sans conséquence */ }
      try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) { /* ancien moteur */ }
      try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) { /* ancien moteur */ }
      // UN seul événement click + action par défaut (soumission de formulaire).
      if (typeof el.click === 'function') {
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent('click', opts));
      }
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
   * Centre (coordonnées viewport) d'un élément, pour les clics CDP.
   * Retourne { x, y } ou null si l'élément n'a pas de boîte.
   */
  dom.elementCenter = function (el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    try {
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    } catch (e) {
      return null;
    }
  };

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

/**
 * tests/submit-simulate.js
 * Tests SIMULÉS de la détection du bouton d'envoi et de la soumission
 * (flow-dom.js) sur un DOM factice.
 *
 * Couvre :
 *  - détection par sélecteurs nommés (level 'named') ;
 *  - repli structurel (level 'structural') ;
 *  - repli contextuel : un seul bouton, puis bouton le plus proche du champ ;
 *  - bouton désactivé ignoré ;
 *  - soumission par clic, et REPLI par touche Entrée quand aucun bouton n'est
 *    identifiable mais que le champ contient du texte ;
 *  - échec explicite si bouton absent ET champ vide ;
 *  - describeInteractiveElements (indispensable au diagnostic).
 *
 * Exécution : node tests/submit-simulate.js
 */

'use strict';

// --- DOM factice minimal mais suffisant --------------------------------------
const map = { qs: {}, qsa: {} };
function reset() { map.qs = {}; map.qsa = {}; }

function el(tag, opts) {
  opts = opts || {};
  const attrs = opts.attrs || {};
  return {
    tagName: tag.toUpperCase(),
    textContent: opts.text || '',
    disabled: !!opts.disabled,
    rect: opts.rect || { left: 0, top: 0, width: 40, height: 20 },
    _events: [],
    clicked: 0,
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    setAttribute(k, v) { attrs[k] = v; },
    getBoundingClientRect() { return this.rect; },
    click() { this.clicked++; },
    dispatchEvent(e) { this._events.push(e); return true; },
    focus() {}
  };
}

global.window = global;
global.document = {
  querySelector: (s) => map.qs[s] || null,
  querySelectorAll: (s) => map.qsa[s] || []
};
global.location = { hostname: 'flow.google.com', pathname: '/project/x' };
global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
// flow-dom utilise `new KeyboardEvent(...)` : fourni ici pour tester le repli Entrée.
global.KeyboardEvent = class {
  constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); }
};

require('../flow-dom.js');
const dom = global.FlowAutomation.dom;

const PROMPT_SEL = 'FAKE_PROMPT';
const NAMED_SEL = 'FAKE_NAMED';
const CONTEXT_SEL = 'button, [role="button"], a[href]';
const DESCRIBE_SEL = 'button, [role="button"], a[href], mat-icon, [contenteditable]';

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

(function run() {
  console.log('\n=== Tests simulés : détection du bouton d\'envoi ===\n');

  dom.setSelectors({ selectors: {
    promptTextarea: { value: PROMPT_SEL },
    submitButton: { value: NAMED_SEL, fallbacks: ['FAKE_FB1', 'FAKE_FB2'] }
  } });

  // --- 1. Sélecteurs nommés ---
  console.log('--- 1. Détection par sélecteurs nommés ---');
  {
    reset();
    const field = el('div', { attrs: { contenteditable: 'true' }, text: 'mon prompt' });
    const btn = el('button', { attrs: { 'aria-label': 'Submit' } });
    map.qs[PROMPT_SEL] = field;
    map.qsa[NAMED_SEL] = [btn];

    const c = dom.getSubmitButtonCandidates();
    assert('level = named', c.level === 'named', c.level);
    assert('bouton trouvé', c.button === btn);
    assert('hasSubmitButton = true', dom.hasSubmitButton() === true);

    const s = dom.submitPrompt();
    assert('submitPrompt via bouton OK', s.ok === true && s.via === 'button', JSON.stringify(s));
    assert('le bouton a été cliqué', btn.clicked === 1, 'clicked=' + btn.clicked);
  }

  // --- 2. Repli structurel ---
  console.log('\n--- 2. Repli structurel (aucun sélecteur nommé) ---');
  {
    reset();
    map.qs[PROMPT_SEL] = el('div', { attrs: { contenteditable: 'true' }, text: 'x' });
    map.qsa[NAMED_SEL] = [];
    map.qsa['FAKE_FB1'] = [];
    const structBtn = el('button');
    map.qsa['FAKE_FB2'] = [structBtn];
    const c = dom.getSubmitButtonCandidates();
    assert('level = structural', c.level === 'structural', c.level);
    assert('bouton de repli retenu', c.button === structBtn);
  }

  // --- 3. Bouton nommé désactivé ignoré ---
  console.log('\n--- 3. Bouton nommé désactivé ignoré ---');
  {
    reset();
    map.qs[PROMPT_SEL] = el('div', { attrs: { contenteditable: 'true' }, text: 'x' });
    map.qsa[NAMED_SEL] = [el('button', { disabled: true })];
    const structBtn = el('button');
    map.qsa['FAKE_FB1'] = [structBtn];
    const c = dom.getSubmitButtonCandidates();
    assert('le bouton désactivé est écarté', c.button === structBtn && c.level === 'structural',
      c.level + '/' + (c.button && c.button.tagName));
  }

  // --- 4. Repli contextuel : un seul bouton visible ---
  console.log('\n--- 4. Repli contextuel : un seul bouton ---');
  {
    reset();
    map.qs[PROMPT_SEL] = el('div', { attrs: { contenteditable: 'true' }, text: 'x' });
    map.qsa[NAMED_SEL] = [];
    map.qsa['FAKE_FB1'] = [];
    map.qsa['FAKE_FB2'] = [];
    const only = el('button', { rect: { left: 10, top: 200, width: 30, height: 30 } });
    map.qsa[CONTEXT_SEL] = [only];
    const c = dom.getSubmitButtonCandidates();
    assert('level = contextual', c.level === 'contextual', c.level);
    assert('unique bouton retenu', c.button === only);
  }

  // --- 5. Repli contextuel : bouton le plus proche du champ ---
  console.log('\n--- 5. Repli contextuel : proximité du champ ---');
  {
    reset();
    const field = el('div', { attrs: { contenteditable: 'true' }, text: 'x',
      rect: { left: 100, top: 300, width: 200, height: 40 } });
    map.qs[PROMPT_SEL] = field;
    map.qsa[NAMED_SEL] = [];
    map.qsa['FAKE_FB1'] = [];
    map.qsa['FAKE_FB2'] = [];
    const far = el('button', { rect: { left: 0, top: 0, width: 20, height: 20 } });
    const near = el('button', { rect: { left: 280, top: 300, width: 24, height: 24 } });
    map.qsa[CONTEXT_SEL] = [far, near];
    const c = dom.getSubmitButtonCandidates();
    assert('le bouton proche du champ est choisi', c.button === near,
      c.button && JSON.stringify(c.button.rect));
  }

  // --- 6. Repli Entrée quand aucun bouton + champ rempli ---
  console.log('\n--- 6. Repli touche Entrée ---');
  {
    reset();
    const field = el('div', { attrs: { contenteditable: 'true' }, text: 'un prompt non vide' });
    map.qs[PROMPT_SEL] = field;
    map.qsa[NAMED_SEL] = [];
    map.qsa['FAKE_FB1'] = [];
    map.qsa['FAKE_FB2'] = [];
    map.qsa[CONTEXT_SEL] = [];
    const s = dom.submitPrompt();
    assert('submitPrompt via entrée', s.ok === true && s.via === 'enter', JSON.stringify(s));
    const sentEnter = field._events.some((e) => e.type === 'keydown' && e.key === 'Enter');
    assert('un keydown Entrée a été émis', sentEnter === true,
      JSON.stringify(field._events.map((e) => e.type + ':' + e.key)));
  }

  // --- 7. Échec explicite : aucun bouton ET champ vide ---
  console.log('\n--- 7. Échec explicite (bouton absent + champ vide) ---');
  {
    reset();
    const field = el('div', { attrs: { contenteditable: 'true' }, text: '   ' });
    map.qs[PROMPT_SEL] = field;
    map.qsa[NAMED_SEL] = [];
    map.qsa['FAKE_FB1'] = [];
    map.qsa['FAKE_FB2'] = [];
    map.qsa[CONTEXT_SEL] = [];
    const s = dom.submitPrompt();
    assert('échec explicite', s.ok === false && s.via === null, JSON.stringify(s));
    assert('message mentionne le champ vide', /champ vide/.test(s.error || ''), s.error);
    const noEnter = !field._events.some((e) => e.key === 'Enter');
    assert('aucune touche Entrée émise', noEnter === true);
  }

  // --- 8. describeInteractiveElements (diagnostic) ---
  console.log('\n--- 8. describeInteractiveElements ---');
  {
    reset();
    const b = el('button', { attrs: { 'aria-label': 'Send' }, text: '' });
    const ic = el('mat-icon', { text: 'arrow_forward' });
    map.qsa[DESCRIBE_SEL] = [b, ic];
    const desc = dom.describeInteractiveElements(12);
    assert('au moins 2 éléments décrits', desc.length === 2, JSON.stringify(desc));
    assert('le bouton expose son aria-label', /button\[aria-label="Send"\]/.test(desc[0]), desc[0]);
    assert('l\'icône mat-icon est décrite', /mat-icon/.test(desc[1]), desc[1]);
  }

  console.log('\n--- Résultat ---');
  console.log('Passed: ' + passed + ' / Failed: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
})();

/**
 * tests/simulate.js
 * Tests unitaires SIMULÉS (hors navigateur) pour la logique pure des modules
 * flow-dom.js, generation-manager.js, queue-manager.js (avec un DOM simulé).
 *
 * Exécution : node tests/simulate.js
 *
 * NOTE : ces tests vérifient la logique avec un DOM factice minimal. Ils ne
 * remplacent pas les tests sur le site réel.
 */

'use strict';

// --- Mini DOM simulé ---
function makeEl(tag, attrs) {
  return {
    tagName: tag.toUpperCase(),
    attrs: attrs || {},
    children: [],
    textContent: '',
    value: '',
    _display: '',
    _visibility: 'visible',
    _rect: { width: 100, height: 50 },
    clickCalls: 0,
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    dispatchEvent() {},
    focus() {},
    appendChild(c) { this.children.push(c); },
    querySelectorAll(sel) { return this.children; },
    getBoundingClientRect() { return this._rect; }
  };
}

// fake window/document minimaliste pour flow-dom.js et generation-manager.js
const fakeDoc = {
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
global.window = global;
global.document = fakeDoc;
global.location = { hostname: 'flow.google.com', pathname: '/project/x' };
// NB : on garde le vrai setTimeout de Node (les délais de test sont courts).

// --- Chargement des modules (ils s'auto-enregistrent sur window.FlowAutomation) ---
require('../flow-dom.js');
require('../generation-manager.js');

const FA = global.FlowAutomation;
const dom = FA.dom;
const generation = FA.generation;

let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✅ ' + name);
  } else {
    failed++;
    console.log('  ❌ ' + name + (detail ? ' — ' + detail : ''));
  }
}

(async function run() {
  console.log('\n=== Tests simulés Flow Automation V0.1 ===\n');

  console.log('--- flow-dom : détection de page ---');
  assert('isFlowPage détecte flow.google.com', dom.isFlowPage() === true);
  assert('isInProject détecte la route /project/', dom.isInProject() === true);

  console.log('\n--- flow-dom : prompt textarea ---');
  // simule un champ contenteditable
  const ta = makeEl('div');
  ta.attrs['contenteditable'] = 'true';
  ta.attrs['role'] = 'textbox';
  ta._rect = { width: 300, height: 50 };
  fakeDoc.querySelector = (sel) => {
    if (sel.indexOf("contenteditable='true'") !== -1) return ta;
    return null;
  };
  fakeDoc.querySelectorAll = () => [];
  assert('hasPromptTextarea trouve le textbox', dom.hasPromptTextarea() === true);
  const wrote = dom.setPromptText('hello world');
  assert('setPromptText écrit le texte', wrote === true && ta.textContent === 'hello world');
  assert('getPromptText relit le texte', dom.getPromptText() === 'hello world');

  console.log('\n--- generation-manager : snapshot & attente ---');
  generation.setConfig({ generationTimeoutMs: 10000, pollIntervalMs: 50, tileStabilityChecks: 2, tileStabilityDelayMs: 20 });

  // simulate tiles state via dom.getResultTiles
  const tile1 = makeEl('flow-tile');
  const vid1 = makeEl('video');
  vid1.src = 'https://x.googlevideo.com/v1.mp4';
  tile1.children = [vid1];
  let tiles = [tile1];

  fakeDoc.querySelectorAll = (sel) => {
    if (sel.indexOf('tile') !== -1) return tiles;
    return [];
  };
  fakeDoc.querySelector = (sel) => {
    if (sel.indexOf("contenteditable") !== -1) return ta;
    if (sel.indexOf("progress") !== -1) return null;
    return null;
  };
  // window.getComputedStyle factice
  global.getComputedStyle = (el) => ({ display: 'visible', visibility: 'visible' });

  // mock du querySelectorAll interne d'une tuile
  tile1.querySelectorAll = (sel) => {
    if (sel === 'video') return [vid1];
    if (sel === 'img') return [];
    return [];
  };

  const snap = generation.snapshot();
  assert('snapshot compte 1 tuile', snap.count === 1, 'count=' + snap.count);
  assert('snapshot détecte 1 média', snap.medias.length === 1, 'medias=' + snap.medias.length);
  assert('snapshot URL média', snap.medias[0].url === 'https://x.googlevideo.com/v1.mp4');

  // test waitForCompletion : baseline 0 tuile, puis 1 tuile stable, pas de progression
  const baseline = { count: 0 };
  // la première snapshot a déjà la tuile -> stable immédiatement
  const comp = await generation.waitForCompletion(baseline, { cancelled: false });
  assert('waitForCompletion ok avec tuile stable', comp.ok === true, JSON.stringify(comp));
  assert('waitForCompletion retourne le média', comp.medias.length === 1);

  // test timeout : baseline 1 tuile, aucune nouvelle tuile
  const baseline2 = { count: 1 };
  const comp2 = await generation.waitForCompletion(baseline2, { cancelled: false });
  assert('waitForCompletion timeout sans nouvelle tuile', comp2.ok === false && comp2.timeout === true);

  // test échec précoce : AUCUN signe de génération (pas de nouvelle tuile, pas de
  // progression, médias identiques au baseline) -> notStarted, sans attendre 180 s.
  generation.setConfig({ generationStartMs: 200, generationTimeoutMs: 5000, pollIntervalMs: 50 });
  const baselineNS = { count: 1, medias: [{ url: 'https://x.googlevideo.com/v1.mp4', type: 'video' }] };
  const compNS = await generation.waitForCompletion(baselineNS, { cancelled: false });
  assert('waitForCompletion notStarted (aucun signe de démarrage)',
    compNS.ok === false && compNS.notStarted === true, JSON.stringify(compNS));

  // si une nouvelle tuile apparaît, il NE doit PAS conclure à un non-démarrage
  generation.setConfig({ generationStartMs: 200, generationTimeoutMs: 3000, pollIntervalMs: 50, tileStabilityChecks: 2 });
  const compSig = await generation.waitForCompletion({ count: 0, medias: [] }, { cancelled: false });
  assert('une nouvelle tuile n\'est pas un non-démarrage',
    compSig.notStarted !== true, JSON.stringify(compSig));

  // test cancelled
  const comp3 = await generation.waitForCompletion(baseline, { cancelled: true });
  assert('waitForCompletion cancelled', comp3.ok === false && comp3.cancelled === true);

  console.log('\n--- generation-manager : checkMediaAccess (hors navigateur, CORS simulé) ---');
  global.fetch = () => Promise.reject(new Error('Failed to fetch'));
  const acc = await generation.checkMediaAccess('https://x.googlevideo.com/v.mp4');
  assert('checkMediaAccess signale CORS/network', acc.ok === false && acc.reason && acc.reason.indexOf('cors-or-network') === 0);

  console.log('\n--- Résultat ---');
  console.log('Passed: ' + passed + ' / Failed: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Erreur de test:', e);
  process.exit(2);
});

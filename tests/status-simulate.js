/**
 * tests/status-simulate.js
 * Tests SIMULÉS de la détection d'état de Google Flow (status.js) et de la
 * logique de diagnostic. Couvre les scénarios du cahier des charges.
 *
 * Exécution : node tests/status-simulate.js
 *
 * IMPORTANT : ces tests valident la LOGIQUE (états, priorités, messages).
 * Ils ne prouvent pas le fonctionnement dans Quetta ; voir le diagnostic
 * intégré de l'extension pour un test sur téléphone.
 */

'use strict';

const status = require('../status.js');

const PROJECT_URL = 'https://flow.google.com/project/207c69fe-016e-420d-bdce-6af7423c8427';

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

function tab(url, st) {
  return { id: 42, url: url, status: st || 'complete', active: true };
}

function pageState(over) {
  return Object.assign({
    url: PROJECT_URL,
    isFlowPage: true,
    isInProject: true,
    readyState: 'complete',
    hasAppRoot: true,
    hasPrompt: true,
    hasSubmit: true,
    tiles: 2
  }, over || {});
}

console.log('\n=== Tests simulés : détection d\'état Flow (status.js) ===\n');

// 1. URL exacte de Flow fournie par l'utilisateur
console.log('--- 1. URL exacte fournie ---');
{
  const r = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: true, pageState: pageState() });
  assert('URL exacte reconnue comme Flow', status.isFlowUrl(PROJECT_URL) === true);
  assert('URL exacte reconnue en projet', status.hasProject(PROJECT_URL) === true);
  assert('état READY', r.code === 'READY', r.code);
  assert('niveau ok', r.level === 'ok');
}

// 2. Page Flow sans projet
console.log('\n--- 2. Page Flow sans projet ---');
{
  const r = status.derive({
    apiAvailable: true,
    tab: tab('https://flow.google.com/'),
    contentPresent: true,
    pageState: pageState({ isInProject: false, url: 'https://flow.google.com/', hasPrompt: false })
  });
  assert('état FLOW_NOT_PROJECT', r.code === 'FLOW_NOT_PROJECT', r.code);
  assert('niveau warn', r.level === 'warn');
}

// 3. Page de projet Flow
console.log('\n--- 3. Page de projet Flow ---');
{
  const r = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: true, pageState: pageState() });
  assert('projet -> READY', r.code === 'READY', r.code);
}

// 4. Page en cours de chargement
console.log('\n--- 4. Page en cours de chargement ---');
{
  const a = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL, 'loading'), contentPresent: false });
  assert('onglet loading sans content -> TAB_LOADING', a.code === 'TAB_LOADING', a.code);
  const b = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: true, pageState: pageState({ readyState: 'loading' }) });
  assert('document loading -> TAB_LOADING', b.code === 'TAB_LOADING', b.code);
  assert('niveau busy', b.level === 'busy');
}

// 5. Content script absent
console.log('\n--- 5. Content script absent ---');
{
  const r = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: false, injectAttempted: true, injectError: 'Cannot access contents of the page' });
  assert('état CONTENT_ABSENT', r.code === 'CONTENT_ABSENT', r.code);
  assert('détail reprend l\'erreur d\'injection', r.detail.indexOf('Cannot access') !== -1, r.detail);
}

// 6. Content script présent
console.log('\n--- 6. Content script présent ---');
{
  const r = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: true, pageState: pageState() });
  assert('présent -> READY', r.code === 'READY', r.code);
}

// 7. Message sans réponse
console.log('\n--- 7. Message sans réponse ---');
{
  const r = status.derive({
    apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: true, pageState: null,
    error: 'The message port closed before a response was received', errorStage: 'PAGE_STATE'
  });
  assert('état CONTENT_NO_RESPONSE', r.code === 'CONTENT_NO_RESPONSE', r.code);
  assert('détail contient l\'erreur', r.detail.indexOf('port closed') !== -1, r.detail);
}

// 8. API browser/chrome indisponible
console.log('\n--- 8. API indisponible ---');
{
  const r = status.derive({ apiAvailable: false });
  assert('état API_UNAVAILABLE', r.code === 'API_UNAVAILABLE', r.code);
  assert('niveau err', r.level === 'err');
}

// 9. Aucun onglet
console.log('\n--- 9. Aucun onglet / mauvais site ---');
{
  const a = status.derive({ apiAvailable: true, tab: null });
  assert('tab null -> NO_TAB', a.code === 'NO_TAB', a.code);
  const b = status.derive({ apiAvailable: true, tab: tab('https://example.com/'), contentPresent: false });
  assert('autre site -> NOT_FLOW', b.code === 'NOT_FLOW', b.code);
}

// 10. Champ / bouton manquants
console.log('\n--- 10. DOM incomplet ---');
{
  const a = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: true, pageState: pageState({ hasPrompt: false }) });
  assert('champ absent -> PROJECT_NO_PROMPT', a.code === 'PROJECT_NO_PROMPT', a.code);
  const b = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: true, pageState: pageState({ hasSubmit: false }) });
  assert('bouton absent -> PROMPT_NO_SUBMIT', b.code === 'PROMPT_NO_SUBMIT', b.code);
  const c = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: true, pageState: pageState({ hasAppRoot: false, hasPrompt: false }) });
  assert('app non montée -> PROJECT_LOADING', c.code === 'PROJECT_LOADING', c.code);
}

// 11. Erreur de communication avec l'onglet (query)
console.log('\n--- 11. Erreur de communication ---');
{
  const r = status.derive({ apiAvailable: true, tab: null, error: 'tabs.query failed', errorStage: 'QUERY_TABS' });
  assert('query en échec -> TAB_QUERY_ERROR', r.code === 'TAB_QUERY_ERROR', r.code);
  const s = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: false, error: 'Could not establish connection', errorStage: 'SEND' });
  assert('send en échec -> TAB_COMM_ERROR', s.code === 'TAB_COMM_ERROR', s.code);
}

// Extra : robustesse de la reconnaissance d'URL
console.log('\n--- Extra : reconnaissance d\'URL ---');
{
  assert('http:// accepté', status.isFlowUrl('http://flow.google.com/x') === true);
  assert('sous-domaine accepté', status.isFlowUrl('https://www.flow.google.com/x') === true);
  assert('lookalike refusé', status.isFlowUrl('https://flow.google.com.evil.com/') === false);
  assert('autre domaine refusé', status.isFlowUrl('https://notflow.google.com/') === false);
  assert('URL vide refusée', status.isFlowUrl('') === false);
  assert('projet détecté', status.hasProject(PROJECT_URL) === true);
  assert('pas de faux projet', status.hasProject('https://flow.google.com/') === false);
}

console.log('\n--- describe() ---');
{
  const r = status.derive({ apiAvailable: true, tab: tab(PROJECT_URL), contentPresent: true, pageState: pageState() });
  const d = status.describe(r);
  assert('describe contient le libellé', d.indexOf('Prêt à générer') !== -1, d);
}

console.log('\n--- Résultat ---');
console.log('Passed: ' + passed + ' / Failed: ' + failed);
process.exit(failed > 0 ? 1 : 0);

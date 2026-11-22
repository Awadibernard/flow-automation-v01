/**
 * tests/queue-simulate.js
 * Tests unitaires SIMULÉS pour queue-manager.js et download-manager.js,
 * avec un mock de chrome.storage.local et de fetch.
 *
 * Exécution : node tests/queue-simulate.js
 */

'use strict';

// --- Mock chrome.storage.local ---
const store = {};
global.chrome = {
  storage: {
    local: {
      _handlers: [],
      async get(key) {
        const k = Array.isArray(key) ? key : [key];
        const out = {};
        for (const kk of k) out[kk] = store[kk];
        return out;
      },
      async set(obj) {
        Object.assign(store, obj);
        const changes = {};
        for (const kk of Object.keys(obj)) changes[kk] = { newValue: obj[kk] };
        this._handlers.forEach((h) => h(changes, 'local'));
      },
      async remove(key) { delete store[key]; },
      onChanged: { addListener(fn) { chrome.storage.local._handlers.push(fn); } }
    },
    onChanged: { addListener() {}, removeListener() {} }
  },
  runtime: {
    async sendMessage() { return { ok: true }; },
    onMessage: { addListener() {} }
  }
};

global.window = global;
global.document = { querySelectorAll: () => [], querySelector: () => null };
global.location = { hostname: 'flow.google.com', pathname: '/project/x' };
global.getComputedStyle = () => ({ display: 'visible', visibility: 'visible' });

require('../storage-manager.js');
require('../flow-dom.js');
require('../generation-manager.js');
require('../download-manager.js');
require('../queue-manager.js');

const FA = global.FlowAutomation;
const queue = FA.queue;
const download = FA.download;

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async function run() {
  console.log('\n=== Tests simulés : file d\'attente & téléchargement ===\n');

  console.log('--- download : slugify ---');
  assert('slugify simple', download.slugify('A cat in space!') === 'a-cat-in-space', download.slugify('A cat in space!'));
  assert('slugify accents supprimés', download.slugify('Été à Paris') === 't-paris', download.slugify('Été à Paris'));
  assert('slugify vide -> prompt', download.slugify('') === 'prompt');

  console.log('\n--- download : buildFilename ---');
  const fn = download.buildFilename(2, 'A red car', { type: 'video' }, 'flow');
  assert('buildFilename vidéo', fn === 'flow/002_a-red-car.mp4', fn);
  const fn2 = download.buildFilename(1, 'A blue sky', { type: 'image' }, '');
  assert('buildFilename image', fn2 === '001_a-blue-sky.jpg', fn2);

  console.log('\n--- queue : create ---');
  queue.create(['prompt one', 'prompt two', '   ', 'prompt three']);
  const st = queue.getState();
  assert('create ignore les lignes vides', st.items.length === 3, 'items=' + st.items.length);
  assert('create initialise IDLE', st.items.every((it) => it.status === 'IDLE'));
  assert('create ne démarre pas', st.isRunning === false);

  console.log('\n--- queue : persistance ---');
  await sleep(50);
  assert('queue persistée dans storage', !!store.queue && store.queue.items.length === 3);

  console.log('\n--- queue : pipeline séquentiel simulé ---');
  let callOrder = [];
  queue.setPipeline(async (item, signal, log) => {
    callOrder.push(item.prompt);
    await sleep(20);
    return { status: 'COMPLETED', medias: [{ url: 'https://x/1.mp4', type: 'video' }] };
  });
  await queue.start();
  await sleep(400);
  const st2 = queue.getState();
  assert('les 3 prompts sont traités', callOrder.length === 3, 'order=' + JSON.stringify(callOrder));
  assert('ordre séquentiel respecté', JSON.stringify(callOrder) === JSON.stringify(['prompt one', 'prompt two', 'prompt three']));
  assert('tous COMPLETED', st2.items.every((it) => it.status === 'COMPLETED'));
  assert('file arrêtée après épuisement', st2.isRunning === false);

  console.log('\n--- queue : restauration après interruption ---');
  // simule une file avec un prompt "en cours"
  store.queue = {
    items: [
      { id: 'p-x-0', prompt: 'done', status: 'COMPLETED', error: null, medias: [], ts: 1 },
      { id: 'p-x-1', prompt: 'was generating', status: 'GENERATING', error: null, medias: [], ts: 2 },
      { id: 'p-x-2', prompt: 'idle', status: 'IDLE', error: null, medias: [], ts: null }
    ],
    currentIndex: 1,
    isRunning: true,
    isPaused: false,
    isCancelled: false
  };
  const restored = await queue.restore();
  const rst = restored.state;
  assert('restauration détectée', restored.restored === true);
  assert('file en pause après restauration', rst.isPaused === true && rst.isRunning === false);
  const interrupted = rst.items.find((it) => it.prompt === 'was generating');
  assert('prompt interrompu -> WAITING_FOR_USER', interrupted.status === 'WAITING_FOR_USER', interrupted.status);
  assert('prompt COMPLETED préservé', rst.items.find((it) => it.prompt === 'done').status === 'COMPLETED');
  assert('aucun prompt relancé (pas de GENERATING actif)',
    rst.items.every((it) => it.status !== 'GENERATING'));

  console.log('\n--- queue : pause / reprise ---');
  store.queue = null;
  queue.create(['a', 'b', 'c', 'd', 'e']);
  let processed = 0;
  queue.setPipeline(async () => { processed++; await sleep(60); return { status: 'COMPLETED', medias: [] }; });
  queue.start();
  await sleep(30);
  queue.pause();
  await sleep(200);
  const paused = queue.getState();
  assert('pause effective', paused.isPaused === true);
  const processedDuringPause = processed;
  await sleep(150);
  assert('aucun prompt traité pendant pause', processed === processedDuringPause, 'processed=' + processed);
  queue.resume();
  await sleep(600);
  assert('tous traités après reprise', queue.getState().items.every((it) => it.status === 'COMPLETED'), 'processed=' + processed);

  console.log('\n--- download : vérification d\'accès (CORS vs HTTP) ---');
  const g = FA.generation;
  const origCheck = g.checkMediaAccess;

  // CORS / réseau (status -1) : non définitif -> on tente quand même
  g.checkMediaAccess = async () => ({ ok: false, status: -1, reason: 'cors' });
  const dl1 = await download.downloadMedias(
    [{ url: 'https://x/a.mp4', type: 'video' }],
    { promptIndex: 1, prompt: 'cors case', folder: 'flow' });
  assert('CORS (-1) -> téléchargement tout de même tenté',
    dl1.results.length === 1 && dl1.results[0].ok === true, JSON.stringify(dl1.results));

  // HTTP 404 : définitif -> pas de téléchargement
  g.checkMediaAccess = async () => ({ ok: false, status: 404 });
  const dl2 = await download.downloadMedias(
    [{ url: 'https://x/b.mp4', type: 'video' }],
    { promptIndex: 2, prompt: 'http case', folder: 'flow' });
  assert('HTTP 404 -> téléchargement évité',
    dl2.results.length === 1 && dl2.results[0].ok === false && dl2.allOk === false,
    JSON.stringify(dl2.results));

  // Accès OK -> téléchargé
  g.checkMediaAccess = async () => ({ ok: true, status: 200 });
  const dl3 = await download.downloadMedias(
    [{ url: 'https://x/c.mp4', type: 'video' }],
    { promptIndex: 3, prompt: 'ok case', folder: 'flow' });
  assert('accès OK -> téléchargé',
    dl3.allOk === true && dl3.results[0].ok === true, JSON.stringify(dl3.results));
  g.checkMediaAccess = origCheck;

  console.log('\n--- Résultat ---');
  console.log('Passed: ' + passed + ' / Failed: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('Erreur:', e); process.exit(2); });

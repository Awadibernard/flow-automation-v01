/**
 * tests/cdp-simulate.js
 * Tests SIMULÉS du contrôle CDP (saisie réelle) — V0.1.6.
 *
 * On simule `chrome.debugger` (attach / detach / sendCommand) et on vérifie :
 *  1. cdp-controller : attachement, insertText, pressKey, click, détachement,
 *     cas « Another debugger is already attached », erreur générique ;
 *  2. flow-dom : dom.elementCenter ;
 *  3. background.js : le routage des messages CDP_* vers chrome.debugger
 *     (preuve que la chaîne content → SW → CDP est câblée).
 *
 * ATTENTION : ces tests sont SIMULÉS (chrome.debugger factice). Ils prouvent la
 * logique et le câblage, PAS le comportement réel de Google Flow.
 *
 * Exécution : node tests/cdp-simulate.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

// --- chrome.debugger factice -------------------------------------------------
function makeChrome() {
  const dbg = { attachMode: 'ok', commands: [], attachedTabs: [] };
  const api = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      getURL: (p) => 'chrome-extension://test/' + p,
      sendMessage: () => Promise.resolve({ ok: true })
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve()
      },
      onChanged: { addListener() {}, removeListener() {} }
    },
    tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve({}) },
    scripting: { executeScript: () => Promise.resolve() },
    downloads: { download: () => Promise.resolve(1) },
    debugger: {
      attach: (target, version, cb) => {
        if (dbg.attachMode === 'err') {
          api.runtime.lastError = { message: 'Impossible de s\'attacher' };
          cb(); delete api.runtime.lastError;
        } else if (dbg.attachMode === 'already') {
          api.runtime.lastError = { message: 'Another debugger is already attached to the tab with id: 1.' };
          cb(); delete api.runtime.lastError;
        } else {
          dbg.attachedTabs.push(target.tabId); cb();
        }
      },
      detach: (target, cb) => { dbg.attachedTabs = dbg.attachedTabs.filter((t) => t !== target.tabId); cb(); },
      sendCommand: (target, method, params, cb) => { dbg.commands.push({ method, params }); cb({}); },
      onDetach: { addListener() {} }
    },
    __dbg: dbg
  };
  return api;
}

// --- Chargement de cdp-controller (IIFE à racine `self`) --------------------
function loadCdp(chromeApi) {
  const win = {};
  const code = fs.readFileSync(path.join(ROOT, 'cdp-controller.js'), 'utf8');
  const fn = new Function('self', 'chrome', 'console', code);
  fn(win, chromeApi, console);
  return win.FlowCdp;
}

// --- Chargement de flow-dom --------------------------------------------------
function loadDom() {
  const map = { qs: {}, qsa: {} };
  const win = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  const doc = { querySelector: (s) => map.qs[s] || null, querySelectorAll: (s) => map.qsa[s] || [] };
  const loc = { hostname: 'flow.google.com', pathname: '/project/x', href: 'https://flow.google.com/project/x' };
  const code = fs.readFileSync(path.join(ROOT, 'flow-dom.js'), 'utf8');
  const fn = new Function('window', 'document', 'location', 'console', code);
  // flow-dom s'attache à window.FlowAutomation ; on lui fournit un objet window
  // qui EST globalThis-like (il utilise window.FlowAutomation et globalThis via IIFE param).
  fn(win, doc, loc, console);
  return win.FlowAutomation.dom;
}

// --- Chargement de background.js dans un monde simulé -----------------------
function loadBackground(chromeApi, win) {
  const listeners = [];
  chromeApi.runtime.onMessage.addListener = (fn) => listeners.push(fn);
  const loc = { hostname: 'flow.google.com', pathname: '/project/x' };
  const code = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const fn = new Function('window', 'self', 'document', 'location', 'chrome', 'browser',
    'structuredClone', 'setInterval', 'setTimeout', 'fetch', 'importScripts', 'console',
    'Promise', 'Object', 'JSON', 'Date', 'Math', 'Array', 'String', 'Number', 'Error', code);
  fn(win, win, { readyState: 'complete' }, loc, chromeApi, undefined,
    (v) => JSON.parse(JSON.stringify(v)), () => 0, (f) => setTimeout(f, 0),
    () => Promise.reject(new Error('no network')),
    () => { /* importScripts mock : FlowCdp déjà posé sur win */ },
    console, Promise, Object, JSON, Date, Math, Array, String, Number, Error);
  return listeners;
}

function send(listener, msg) {
  return new Promise((resolve) => {
    listener(msg, {}, (r) => resolve(r));
  });
}

(async function run() {
  console.log('\n=== Tests simulés : contrôle CDP (V0.1.6) ===\n');

  // --- 1. cdp-controller : attachement + insertText ---
  console.log('--- 1. cdp-controller : attachement et insertText ---');
  {
    const chromeApi = makeChrome();
    const win = {};
    const cdp = loadCdp(chromeApi);
    assert('isAvailable = true', cdp.isAvailable() === true);

    const r = await cdp.insertText(42, 'bonjour');
    assert('insertText OK', r.ok === true, JSON.stringify(r));
    assert('onglet attaché', chromeApi.__dbg.attachedTabs.indexOf(42) !== -1);
    assert('commande Input.insertText émise',
      chromeApi.__dbg.commands.some((c) => c.method === 'Input.insertText' && c.params.text === 'bonjour'),
      JSON.stringify(chromeApi.__dbg.commands));
    assert('isAttached(42) = true', cdp.isAttached(42) === true);
    void win;
  }

  // --- 2. pressKey : keyDown + keyUp ---
  console.log('\n--- 2. cdp-controller : pressKey (Entrée) ---');
  {
    const chromeApi = makeChrome();
    const cdp = loadCdp(chromeApi);
    const r = await cdp.pressKey(7, 'Enter');
    assert('pressKey OK', r.ok === true, JSON.stringify(r));
    const keys = chromeApi.__dbg.commands.filter((c) => c.method === 'Input.dispatchKeyEvent');
    assert('keyDown + keyUp émis', keys.length === 2, 'n=' + keys.length);
    assert('touche = Enter', keys[0] && keys[0].params.key === 'Enter', JSON.stringify(keys[0]));
    assert('type keyDown', keys[0] && keys[0].params.type === 'keyDown');
    assert('type keyUp', keys[1] && keys[1].params.type === 'keyUp');
  }

  // --- 3. click : mouseMoved + pressed + released ---
  console.log('\n--- 3. cdp-controller : clic souris réel ---');
  {
    const chromeApi = makeChrome();
    const cdp = loadCdp(chromeApi);
    const r = await cdp.click(9, 120, 340);
    assert('click OK', r.ok === true, JSON.stringify(r));
    const mice = chromeApi.__dbg.commands.filter((c) => c.method === 'Input.dispatchMouseEvent');
    assert('3 événements souris', mice.length === 3, 'n=' + mice.length);
    const types = mice.map((m) => m.params.type).join(',');
    assert('ordre moved/pressed/released', types === 'mouseMoved,mousePressed,mouseReleased', types);
    assert('coordonnées transmises', mice[1].params.x === 120 && mice[1].params.y === 340,
      JSON.stringify(mice[1].params));
    assert('bouton gauche pressé', mice[1].params.button === 'left' && mice[1].params.clickCount === 1);
  }

  // --- 4. Détachement ---
  console.log('\n--- 4. cdp-controller : détachement ---');
  {
    const chromeApi = makeChrome();
    const cdp = loadCdp(chromeApi);
    await cdp.attach(3);
    assert('attaché avant détachement', cdp.isAttached(3) === true);
    await cdp.detach(3);
    assert('détaché après', cdp.isAttached(3) === false);
  }

  // --- 5. Cas « déjà attaché » ---
  console.log('\n--- 5. cdp-controller : déjà attaché (toléré) ---');
  {
    const chromeApi = makeChrome();
    chromeApi.__dbg.attachMode = 'already';
    const cdp = loadCdp(chromeApi);
    const r = await cdp.attach(5);
    assert('attach tolère « already attached »', r.ok === true, JSON.stringify(r));
    assert('already = true', r.already === true);
  }

  // --- 6. Erreur d'attachement générique ---
  console.log('\n--- 6. cdp-controller : échec d\'attachement explicite ---');
  {
    const chromeApi = makeChrome();
    chromeApi.__dbg.attachMode = 'err';
    const cdp = loadCdp(chromeApi);
    const r = await cdp.attach(6);
    assert('attach échoue proprement', r.ok === false && /attach/i.test(r.error || ''), JSON.stringify(r));
    const ins = await cdp.insertText(6, 'x');
    assert('insertText échoue sans lever', ins.ok === false, JSON.stringify(ins));
  }

  // --- 7. API debugger absente ---
  console.log('\n--- 7. cdp-controller : API debugger absente ---');
  {
    const chromeApi = makeChrome();
    delete chromeApi.debugger;
    const cdp = loadCdp(chromeApi);
    assert('isAvailable = false', cdp.isAvailable() === false);
    const r = await cdp.attach(1);
    assert('attach refuse proprement', r.ok === false && /indisponible/i.test(r.error || ''), JSON.stringify(r));
  }

  // --- 8. dom.elementCenter ---
  console.log('\n--- 8. flow-dom : elementCenter ---');
  {
    const dom = loadDom();
    const c = dom.elementCenter({ getBoundingClientRect: () => ({ left: 10, top: 20, width: 40, height: 60 }) });
    assert('centre calculé', c && c.x === 30 && c.y === 50, JSON.stringify(c));
    const c2 = dom.elementCenter({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) });
    assert('boîte nulle → null', c2 === null, JSON.stringify(c2));
    assert('élément nul → null', dom.elementCenter(null) === null);
  }

  // --- 9. background.js : routage CDP_INSERT_TEXT ---
  console.log('\n--- 9. background : routage CDP_INSERT_TEXT -> Input.insertText ---');
  {
    const chromeApi = makeChrome();
    const win = {};
    win.FlowCdp = loadCdp(chromeApi);
    const listeners = loadBackground(chromeApi, win);
    assert('un écouteur de messages', listeners.length === 1, 'n=' + listeners.length);

    const r = await send(listeners[0], { type: 'CDP_INSERT_TEXT', text: 'salut', tabId: 77 });
    assert('réponse ok', r && r.ok === true, JSON.stringify(r));
    assert('Input.insertText atteint chrome.debugger',
      chromeApi.__dbg.commands.some((c) => c.method === 'Input.insertText' && c.params.text === 'salut'),
      JSON.stringify(chromeApi.__dbg.commands));
  }

  // --- 10. background.js : routage CDP_CLICK ---
  console.log('\n--- 10. background : routage CDP_CLICK ---');
  {
    const chromeApi = makeChrome();
    const win = {};
    win.FlowCdp = loadCdp(chromeApi);
    const listeners = loadBackground(chromeApi, win);
    const r = await send(listeners[0], { type: 'CDP_CLICK', x: 5, y: 6, tabId: 88 });
    assert('réponse ok', r && r.ok === true, JSON.stringify(r));
    assert('clic souris propagé',
      chromeApi.__dbg.commands.some((c) => c.method === 'Input.dispatchMouseEvent'),
      JSON.stringify(chromeApi.__dbg.commands));
  }

  // --- 11. background.js : CDP_AVAILABLE ---
  console.log('\n--- 11. background : CDP_AVAILABLE ---');
  {
    const chromeApi = makeChrome();
    const win = {};
    win.FlowCdp = loadCdp(chromeApi);
    const listeners = loadBackground(chromeApi, win);
    const r = await send(listeners[0], { type: 'CDP_AVAILABLE' });
    assert('available = true', r && r.available === true, JSON.stringify(r));
  }

  console.log('\n--- Résultat ---');
  console.log('Passed: ' + passed + ' / Failed: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Erreur de test:', e);
  process.exit(2);
});

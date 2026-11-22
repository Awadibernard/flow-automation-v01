/**
 * cdp-controller.js — Flow Automation
 *
 * Contrôle « réel » du navigateur via le protocole Chrome DevTools (CDP).
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * La page Google Flow n'accepte de lancer une génération que sur des
 * événements « de confiance » (`event.isTrusted === true`). Or AUCUN événement
 * fabriqué en JavaScript (`new MouseEvent(...)`, `el.click()`) n'est
 * « de confiance » : le navigateur les marque `isTrusted: false`. C'est la
 * cause réelle de « le prompt est collé mais la génération ne démarre pas ».
 *
 * `chrome.debugger` (CDP) est le SEUL moyen, depuis une extension MV3, de
 * produire des entrées de confiance :
 *   - `Input.insertText`         → saisie de texte réelle
 *   - `Input.dispatchKeyEvent`   → touche réelle (Entrée…)
 *   - `Input.dispatchMouseEvent` → clic souris réel
 *
 * C'est exactement la technique utilisée par l'extension commerciale d'origine
 * (permission `debugger`, `Input.insertText`, `Input.dispatchKeyEvent`).
 *
 * OPTIONNEL PAR PRINCIPE
 * ----------------------
 * Ce module n'est JAMAIS utilisé sans que l'utilisateur ait activé l'option
 * « Saisie réelle (CDP) ». Il n'y a ici AUCUNE dissimulation : l'utilisateur
 * est averti qu'un bandeau « Un outil de débogage contrôle ce navigateur »
 * peut apparaître. Aucun contournement d'anti-détection.
 *
 * Exposé globalement comme `FlowCdp` (chargé par background.js via
 * importScripts ; testable en Node avec un `chrome` simulé).
 */

(function (root) {
  'use strict';

  // Onglets actuellement attachés (clé = String(tabId)).
  const attached = Object.create(null);
  let detachListenerInstalled = false;

  function getApi() {
    if (typeof chrome === 'undefined' || !chrome) return null;
    return chrome;
  }

  /** L'API chrome.debugger est-elle présente et complète dans ce navigateur ? */
  function isAvailable() {
    const c = getApi();
    return !!(c && c.debugger && c.debugger.attach && c.debugger.detach && c.debugger.sendCommand);
  }

  function isAttached(tabId) {
    return tabId != null && !!attached[String(tabId)];
  }

  /**
   * Installe (une seule fois) l'écouteur de détachement : si un autre outil
   * prend le débogueur, ou si l'onglet se ferme, on met à jour notre état.
   */
  function installDetachListener() {
    if (detachListenerInstalled) return;
    const c = getApi();
    try {
      if (c && c.debugger && c.debugger.onDetach && c.debugger.onDetach.addListener) {
        c.debugger.onDetach.addListener(function (source) {
          const id = source && source.tabId;
          if (id != null) delete attached[String(id)];
        });
        detachListenerInstalled = true;
      }
    } catch (e) {
      // Sans écouteur, l'état peut rester optimiste : jamais bloquant.
    }
  }

  /**
   * Convertit un appel CDP basé callback (API chrome.debugger) en promesse.
   * Lit `chrome.runtime.lastError` DANS le callback (obligatoire en MV3).
   */
  function cdpCall(fn, thisArg, args) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const cb = function (result) {
        if (done) return;
        done = true;
        const c = getApi();
        const err = c && c.runtime && c.runtime.lastError;
        if (err) reject(new Error(err.message || 'Erreur CDP'));
        else resolve(result);
      };
      try {
        fn.apply(thisArg, (args || []).concat([cb]));
      } catch (e) {
        if (!done) { done = true; reject(e); }
      }
    });
  }

  /**
   * Attache le débogueur à l'onglet (idempotent).
   * Tolère « Another debugger is already attached » (DevTools ouvert, ou
   * attachement précédent) : dans ce cas on considère l'onglet utilisable.
   */
  async function attach(tabId) {
    if (!isAvailable()) return { ok: false, error: 'API chrome.debugger indisponible (permission non accordée ?)' };
    if (tabId == null) return { ok: false, error: 'tabId manquant' };
    installDetachListener();
    if (isAttached(tabId)) return { ok: true, already: true };

    const c = getApi();
    try {
      await cdpCall(c.debugger.attach, c.debugger, [{ tabId: tabId }, '1.3']);
      attached[String(tabId)] = true;
      return { ok: true };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/already attached/i.test(msg)) {
        // Déjà attaché (par nous ou un autre outil) : utilisable en l'état.
        attached[String(tabId)] = true;
        return { ok: true, already: true };
      }
      return { ok: false, error: msg };
    }
  }

  /** Détache le débogueur (retire le bandeau). Ne jette jamais. */
  async function detach(tabId) {
    if (tabId != null) delete attached[String(tabId)];
    if (!isAvailable() || tabId == null) return { ok: true };
    const c = getApi();
    try {
      await cdpCall(c.debugger.detach, c.debugger, [{ tabId: tabId }]);
    } catch (e) {
      // Pas attaché : sans conséquence.
    }
    return { ok: true };
  }

  /** Envoie une commande CDP brute. */
  async function send(tabId, method, params) {
    if (!isAvailable()) return { ok: false, error: 'API chrome.debugger indisponible' };
    if (tabId == null) return { ok: false, error: 'tabId manquant' };
    const c = getApi();
    try {
      const result = await cdpCall(c.debugger.sendCommand, c.debugger,
        [{ tabId: tabId }, method, params || {}]);
      return { ok: true, result: result };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** Insère du texte comme une vraie frappe dans l'élément actuellement focalisé. */
  async function insertText(tabId, text) {
    const a = await attach(tabId);
    if (!a.ok) return a;
    return send(tabId, 'Input.insertText', { text: String(text == null ? '' : text) });
  }

  /**
   * Envoie une touche réelle (keyDown + keyUp). Supporte au minimum Entrée.
   */
  async function pressKey(tabId, key) {
    const a = await attach(tabId);
    if (!a.ok) return a;
    const name = key || 'Enter';
    const MAP = { Enter: 13, Tab: 9, Escape: 27, ' ': 32 };
    const vk = MAP[name] || 0;
    const downParams = {
      type: 'keyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      code: name, key: name
    };
    if (name === 'Enter') {
      downParams.text = '\r';
      downParams.unmodifiedText = '\r';
    }
    const down = await send(tabId, 'Input.dispatchKeyEvent', downParams);
    if (!down.ok) return down;
    return send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      code: name, key: name
    });
  }

  /** Clic souris réel aux coordonnées viewport (x, y) données. */
  async function click(tabId, x, y) {
    const a = await attach(tabId);
    if (!a.ok) return a;
    const px = Number(x) || 0;
    const py = Number(y) || 0;
    const move = await send(tabId, 'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: px, y: py, button: 'none' });
    if (!move.ok) return move;
    const press = await send(tabId, 'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
    if (!press.ok) return press;
    return send(tabId, 'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
  }

  root.FlowCdp = {
    isAvailable: isAvailable,
    isAttached: isAttached,
    attach: attach,
    detach: detach,
    send: send,
    insertText: insertText,
    pressKey: pressKey,
    click: click
  };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));

/**
 * content.js
 * Runs in the MAIN world of every page.
 * Injects the window.bitcoin provider object and bridges
 * messages between the page and the background service worker.
 *
 * Security model:
 *  - This script is the ONLY bridge between untrusted page JS and the extension.
 *  - It validates message structure before forwarding.
 *  - It never exposes private keys or the password to the page.
 */

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__boltWalletInjected) return;
  window.__boltWalletInjected = true;

  // ─── Message Bridge ────────────────────────────────────────────────────

  /**
   * Listens for postMessage events from provider.js (in-page) and
   * forwards them to the background service worker via chrome.runtime.
   */
  window.addEventListener('message', (event) => {
    // Only accept messages from the same frame, same origin
    if (event.source !== window) return;
    if (!event.data || event.data.target !== 'BOLT_CONTENT') return;

    const { requestId, method, params } = event.data;

    // Basic validation
    if (typeof method !== 'string') return;

    // Forward to background
    chrome.runtime.sendMessage(
      {
        type: 'PROVIDER_REQUEST',
        payload: { method, params, requestId },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          window.postMessage({
            target: 'BOLT_PROVIDER',
            requestId,
            error: 'Extension communication error: ' + chrome.runtime.lastError.message,
          }, '*');
          return;
        }

        // Forward response back to the page
        window.postMessage({
          target: 'BOLT_PROVIDER',
          requestId,
          ...(response.ok
            ? { result: response.result }
            : { error: response.error }),
        }, '*');
      }
    );
  });

  // ─── Announce Provider ────────────────────────────────────────────────

  /**
   * Inject the provider script into the page.
   * We do this instead of just assigning window.bitcoin directly
   * because the MAIN world content script has access to the page's
   * window object – we can set window.bitcoin here directly.
   */
  injectProvider();

  function injectProvider() {
    // Define window.bitcoin inline (provider object)
    // This avoids needing a separate provider.js injection for MV3
    const provider = createProvider();
    Object.defineProperty(window, 'bitcoin', {
      value: provider,
      writable: false,
      configurable: false,
    });

    // Dispatch an event so dApps know the provider is ready
    window.dispatchEvent(new Event('bolt:ready'));
    console.log('[Bolt Wallet] Provider injected as window.bitcoin');
  }

  // ─── Provider Implementation ──────────────────────────────────────────

  function createProvider() {
    let requestCounter = 0;
    const pendingCallbacks = new Map();

    // Listen for responses from the bridge
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (!event.data || event.data.target !== 'BOLT_PROVIDER') return;

      const { requestId, result, error } = event.data;
      const pending = pendingCallbacks.get(requestId);
      if (!pending) return;

      pendingCallbacks.delete(requestId);
      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(result);
      }
    });

    /**
     * Core RPC method – sends a request to the extension.
     * @param {{ method: string, params?: object }} request
     * @returns {Promise<any>}
     */
    function request({ method, params = {} }) {
      return new Promise((resolve, reject) => {
        const requestId = `bolt_${++requestCounter}_${Date.now()}`;
        pendingCallbacks.set(requestId, { resolve, reject });

        window.postMessage({
          target: 'BOLT_CONTENT',
          requestId,
          method,
          params,
        }, '*');

        // Timeout after 5 minutes (approval popups can take a while)
        setTimeout(() => {
          if (pendingCallbacks.has(requestId)) {
            pendingCallbacks.delete(requestId);
            reject(new Error('Request timed out'));
          }
        }, 300_000);
      });
    }

    // ── Event emitter for provider events ──
    const listeners = new Map();

    function on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
    }

    function off(event, callback) {
      listeners.get(event)?.delete(callback);
    }

    function emit(event, data) {
      listeners.get(event)?.forEach(cb => cb(data));
    }

    // ── Convenience methods ──
    const api = {
      /**
       * MetaMask-compatible RPC interface.
       * @example await window.bitcoin.request({ method: 'getAccounts' })
       */
      request,

      /** Shorthand: connect to the wallet (request access) */
      connect: () => request({ method: 'connect' }),

      /** Shorthand: get current accounts */
      getAccounts: () => request({ method: 'getAccounts' }),

      /** Shorthand: get Lightning balance */
      getBalance: () => request({ method: 'getBalance' }),

      /** Shorthand: pay a BOLT11 invoice */
      payInvoice: (invoice, maxFeeSats) =>
        request({ method: 'payInvoice', params: { invoice, maxFeeSats } }),

      /** Shorthand: create a BOLT11 invoice */
      createInvoice: (amountSats, description, expiry) =>
        request({ method: 'createInvoice', params: { amountSats, description, expiry } }),

      /** Shorthand: sign a message with your Bitcoin key */
      signMessage: (message) =>
        request({ method: 'signMessage', params: { message } }),

      /** Shorthand: get public key */
      getPublicKey: () => request({ method: 'getPublicKey' }),

      /** Shorthand: get transactions */
      getTransactions: (limit) =>
        request({ method: 'getTransactions', params: { limit } }),

      on,
      off,

      // Provider metadata
      isBolt: true,
      isBitcoin: true,
      version: '1.0.0',
      network: 'mainnet',
    };

    return Object.freeze(api);
  }

})();

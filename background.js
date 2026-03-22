/**
 * background.js
 * Service Worker – central wallet brain.
 * Handles:
 *  - Key management
 *  - Lightning operations
 *  - Permission management
 *  - Message routing from content scripts & popup
 */

import { encrypt, decrypt } from './crypto/encryption.js';
import { generateMnemonic, generateKeypair, keypairFromMnemonic, signMessage } from './crypto/wallet.js';
import * as MockLightning from './lightning/mock.js';
import { createLNDClient } from './lightning/lnd.js';

// ─── State ────────────────────────────────────────────────────────────────

/** Unlocked session state (cleared when extension is locked) */
let session = {
  unlocked: false,
  privateKey: null,
  publicKey: null,
  address: null,
  password: null, // ephemeral – used for re-encryption only
};

/** Pending requests awaiting user approval { [requestId]: { resolve, reject, meta } } */
const pendingRequests = new Map();

/** Storage key names */
const STORAGE_KEYS = {
  VAULT: 'bolt_vault',           // encrypted keystore
  ACCOUNTS: 'bolt_accounts',     // account metadata
  PERMISSIONS: 'bolt_permissions', // site permissions
  SETTINGS: 'bolt_settings',      // LND config, preferences
  TX_HISTORY: 'bolt_tx_history',  // cached transaction history
};

// ─── Utility ─────────────────────────────────────────────────────────────

function generateRequestId() {
  return 'req_' + Math.random().toString(36).slice(2) + '_' + Date.now();
}

async function getStorage(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => resolve(result[key]));
  });
}

async function setStorage(key, value) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function getLightning() {
  // In production, check settings and return LND client if configured
  // For now, always use mock
  return MockLightning;
}

// ─── Wallet Lifecycle ─────────────────────────────────────────────────────

async function createWallet(password) {
  const mnemonic = generateMnemonic();
  const keypair = await keypairFromMnemonic(mnemonic);

  const vault = {
    mnemonic: await encrypt(mnemonic, password),
    privateKey: await encrypt(keypair.privateKey, password),
    publicKey: keypair.publicKey,
    address: keypair.address,
    createdAt: Date.now(),
    version: 1,
  };

  await setStorage(STORAGE_KEYS.VAULT, vault);
  await setStorage(STORAGE_KEYS.ACCOUNTS, [{
    id: 'account_0',
    name: 'Account 1',
    address: keypair.address,
    publicKey: keypair.publicKey,
    index: 0,
  }]);

  session = {
    unlocked: true,
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    address: keypair.address,
    password,
  };

  return { address: keypair.address, mnemonic };
}

async function unlockWallet(password) {
  const vault = await getStorage(STORAGE_KEYS.VAULT);
  if (!vault) throw new Error('No wallet found. Please create one first.');

  // Attempt decryption – will throw on wrong password
  const privateKey = await decrypt(vault.privateKey, password);

  session = {
    unlocked: true,
    privateKey,
    publicKey: vault.publicKey,
    address: vault.address,
    password,
  };

  return { address: vault.address, publicKey: vault.publicKey };
}

function lockWallet() {
  session = { unlocked: false, privateKey: null, publicKey: null, address: null, password: null };
}

async function isWalletSetup() {
  const vault = await getStorage(STORAGE_KEYS.VAULT);
  return !!vault;
}

// ─── Permission Management ────────────────────────────────────────────────

async function getPermissions() {
  return (await getStorage(STORAGE_KEYS.PERMISSIONS)) || {};
}

async function setPermission(origin, granted) {
  const permissions = await getPermissions();
  permissions[origin] = { granted, grantedAt: Date.now() };
  await setStorage(STORAGE_KEYS.PERMISSIONS, permissions);
}

async function hasPermission(origin) {
  const permissions = await getPermissions();
  return permissions[origin]?.granted === true;
}

async function revokePermission(origin) {
  const permissions = await getPermissions();
  delete permissions[origin];
  await setStorage(STORAGE_KEYS.PERMISSIONS, permissions);
}

// ─── Approval Flow ────────────────────────────────────────────────────────

/**
 * Opens the approval popup and waits for user response.
 * @param {object} requestMeta - data to show in popup
 * @returns {Promise<boolean>}
 */
async function requestApproval(requestMeta) {
  const requestId = generateRequestId();

  const approvalPromise = new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject, meta: requestMeta });
  });

  // Open popup with the pending request
  await chrome.action.openPopup().catch(() => {
    // Fallback: open in a window
    chrome.windows.create({
      url: `popup/popup.html?requestId=${requestId}`,
      type: 'popup',
      width: 380,
      height: 620,
    });
  });

  // Store pending request so popup can retrieve it
  await setStorage('pending_approval_' + requestId, requestMeta);

  return approvalPromise;
}

// ─── Provider API Handlers ────────────────────────────────────────────────

const HANDLERS = {

  async getAccounts(params, origin) {
    if (!session.unlocked) throw new Error('Wallet is locked');
    if (!await hasPermission(origin)) {
      throw new Error('UNAUTHORIZED: Call connect() first');
    }
    return [session.address];
  },

  async connect(params, origin) {
    if (!session.unlocked) throw new Error('Wallet is locked');
    if (await hasPermission(origin)) {
      return { address: session.address, publicKey: session.publicKey };
    }
    // Show approval popup
    const approved = await requestApproval({
      type: 'connect',
      origin,
      description: `${origin} wants to connect to your wallet`,
    });
    if (!approved) throw new Error('USER_REJECTED');
    await setPermission(origin, true);
    return { address: session.address, publicKey: session.publicKey };
  },

  async getBalance(params, origin) {
    if (!session.unlocked) throw new Error('Wallet is locked');
    if (!await hasPermission(origin)) throw new Error('UNAUTHORIZED');
    return getLightning().getBalance();
  },

  async getPublicKey(params, origin) {
    if (!session.unlocked) throw new Error('Wallet is locked');
    if (!await hasPermission(origin)) throw new Error('UNAUTHORIZED');
    return { publicKey: session.publicKey, address: session.address };
  },

  async payInvoice({ invoice, maxFeeSats }, origin) {
    if (!session.unlocked) throw new Error('Wallet is locked');
    if (!await hasPermission(origin)) throw new Error('UNAUTHORIZED');

    // Decode invoice for display
    const decoded = getLightning().decodeBolt11(invoice);
    const amountSats = decoded?.amountSats || 0;

    // Require user approval
    const approved = await requestApproval({
      type: 'payInvoice',
      origin,
      invoice,
      amountSats,
      description: decoded?.description || 'Lightning payment',
      maxFeeSats: maxFeeSats || 100,
    });
    if (!approved) throw new Error('USER_REJECTED');

    const result = await getLightning().payInvoice({ invoice, maxFeeSats: maxFeeSats || 100 });

    // Cache to tx history
    await cacheTransaction({ ...result, type: 'send', invoice, origin });
    return result;
  },

  async createInvoice({ amountSats, description, expiry }, origin) {
    if (!session.unlocked) throw new Error('Wallet is locked');
    if (!await hasPermission(origin)) throw new Error('UNAUTHORIZED');
    return getLightning().createInvoice({ amountSats, description, expiry });
  },

  async signMessage({ message }, origin) {
    if (!session.unlocked) throw new Error('Wallet is locked');
    if (!await hasPermission(origin)) throw new Error('UNAUTHORIZED');

    const approved = await requestApproval({
      type: 'signMessage',
      origin,
      message,
      description: `${origin} wants to sign a message with your key`,
    });
    if (!approved) throw new Error('USER_REJECTED');

    return signMessage(message, session.privateKey);
  },

  async getTransactions(params, origin) {
    if (!session.unlocked) throw new Error('Wallet is locked');
    if (!await hasPermission(origin)) throw new Error('UNAUTHORIZED');
    return getLightning().getTransactions(params);
  },
};

// ─── Transaction Cache ────────────────────────────────────────────────────

async function cacheTransaction(tx) {
  const history = (await getStorage(STORAGE_KEYS.TX_HISTORY)) || [];
  history.unshift({ ...tx, cachedAt: Date.now() });
  await setStorage(STORAGE_KEYS.TX_HISTORY, history.slice(0, 100));
}

// ─── Message Handling ─────────────────────────────────────────────────────

/**
 * Routes messages from content scripts and popup.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(result => sendResponse({ ok: true, result }))
    .catch(err => sendResponse({ ok: false, error: err.message }));
  return true; // keep channel open for async
});

async function handleMessage(message, sender) {
  const { type, payload } = message;
  const origin = sender.tab?.url ? new URL(sender.tab.url).origin : 'extension';

  switch (type) {
    // ── Provider requests (from content scripts) ──
    case 'PROVIDER_REQUEST': {
      const { method, params, requestId } = payload;
      const handler = HANDLERS[method];
      if (!handler) throw new Error(`Unknown method: ${method}`);
      return handler(params || {}, origin);
    }

    // ── Approval responses (from popup) ──
    case 'APPROVAL_RESPONSE': {
      const { requestId, approved } = payload;
      const pending = pendingRequests.get(requestId);
      if (!pending) throw new Error('Unknown request ID');
      pendingRequests.delete(requestId);
      await chrome.storage.local.remove('pending_approval_' + requestId);
      pending.resolve(approved);
      return { ok: true };
    }

    // ── Popup management commands ──
    case 'GET_STATE':
      return getWalletState();

    case 'CREATE_WALLET':
      return createWallet(payload.password);

    case 'UNLOCK_WALLET':
      return unlockWallet(payload.password);

    case 'LOCK_WALLET':
      lockWallet();
      return { ok: true };

    case 'GET_PENDING_APPROVAL': {
      const { requestId } = payload;
      const data = await getStorage('pending_approval_' + requestId);
      const pending = pendingRequests.get(requestId);
      return { data, hasPending: !!pending };
    }

    case 'GET_ALL_PENDING': {
      const allPending = [];
      for (const [reqId, req] of pendingRequests) {
        allPending.push({ requestId: reqId, ...req.meta });
      }
      return allPending;
    }

    case 'GET_PERMISSIONS':
      return getPermissions();

    case 'REVOKE_PERMISSION':
      await revokePermission(payload.origin);
      return { ok: true };

    case 'GET_BALANCE':
      return getLightning().getBalance();

    case 'GET_TRANSACTIONS':
      return getLightning().getTransactions(payload || {});

    case 'CREATE_INVOICE':
      return getLightning().createInvoice(payload);

    case 'PAY_INVOICE_MANUAL': {
      // Manual payment from popup (no approval needed)
      if (!session.unlocked) throw new Error('Wallet locked');
      const result = await getLightning().payInvoice(payload);
      await cacheTransaction({ ...result, type: 'send', ...payload });
      return result;
    }

    case 'SIMULATE_RECEIVE':
      return MockLightning.simulateIncomingPayment(payload);

    case 'IS_SETUP':
      return { isSetup: await isWalletSetup(), isUnlocked: session.unlocked };

    case 'GET_SETTINGS':
      return getStorage(STORAGE_KEYS.SETTINGS);

    case 'SAVE_SETTINGS':
      await setStorage(STORAGE_KEYS.SETTINGS, payload);
      return { ok: true };

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

async function getWalletState() {
  return {
    unlocked: session.unlocked,
    address: session.address,
    publicKey: session.publicKey,
    isSetup: await isWalletSetup(),
  };
}

// ─── Auto-lock after 30 minutes of inactivity ─────────────────────────────
chrome.alarms.create('auto_lock', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'auto_lock' && session.unlocked) {
    lockWallet();
  }
});

console.log('[Bolt Wallet] Background service worker started');

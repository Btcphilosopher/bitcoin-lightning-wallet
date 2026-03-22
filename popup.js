/**
 * popup.js
 * Popup UI controller.
 * Communicates with background.js via chrome.runtime.sendMessage.
 */

// ─── Messaging ────────────────────────────────────────────────────────────

async function bg(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error('No response from background'));
      if (!response.ok) return reject(new Error(response.error));
      resolve(response.result);
    });
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2500);
}

// ─── Screen Navigation ────────────────────────────────────────────────────

const screens = document.querySelectorAll('.screen');
const panels = document.querySelectorAll('.panel');

function showScreen(id) {
  screens.forEach(s => s.classList.add('hidden'));
  document.getElementById(id)?.classList.remove('hidden');
}

function showPanel(id) {
  panels.forEach(p => p.classList.add('hidden'));
  document.getElementById(id)?.classList.remove('hidden');
}

function hideAllPanels() {
  panels.forEach(p => p.classList.add('hidden'));
}

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    // Check if this popup was opened for an approval
    const params = new URLSearchParams(window.location.search);
    const requestId = params.get('requestId');
    if (requestId) {
      return initApprovalScreen(requestId);
    }

    const { isSetup, isUnlocked } = await bg('IS_SETUP');

    if (!isSetup) {
      showScreen('screen-setup');
    } else if (isUnlocked) {
      await loadMainScreen();
    } else {
      showScreen('screen-unlock');
      document.getElementById('unlock-password').focus();
    }

    // Also check for any pending approvals
    await checkPendingApprovals();

  } catch (err) {
    console.error('[Bolt] Init error:', err);
    showScreen('screen-setup');
  }
}

async function checkPendingApprovals() {
  try {
    const pending = await bg('GET_ALL_PENDING');
    if (pending && pending.length > 0) {
      showApprovalFor(pending[0].requestId, pending[0]);
    }
  } catch {}
}

// ─── Main Screen ──────────────────────────────────────────────────────────

async function loadMainScreen() {
  showScreen('screen-main');
  await Promise.all([loadBalance(), loadTransactions(), loadSites()]);
}

async function loadBalance() {
  try {
    const balance = await bg('GET_BALANCE');
    document.getElementById('display-sats').textContent =
      `${balance.sats.toLocaleString()} sats`;
    document.getElementById('display-btc').textContent = `${balance.btc} BTC`;
  } catch (err) {
    document.getElementById('display-sats').textContent = 'Error loading balance';
  }

  try {
    const state = await bg('GET_STATE');
    const addr = state.address || '';
    document.getElementById('display-address').textContent =
      addr.slice(0, 10) + '…' + addr.slice(-8);
    document.getElementById('display-address').dataset.full = addr;
  } catch {}
}

async function loadTransactions() {
  const list = document.getElementById('tx-list');
  try {
    const txs = await bg('GET_TRANSACTIONS', { limit: 20 });
    if (!txs.length) {
      list.innerHTML = '<div class="empty-state">No transactions yet</div>';
      return;
    }
    list.innerHTML = txs.map(tx => `
      <div class="tx-item">
        <div class="tx-icon ${tx.type}">${tx.type === 'send' ? '↑' : '↓'}</div>
        <div class="tx-info">
          <div class="tx-desc">${escapeHtml(tx.description || 'Lightning payment')}</div>
          <div class="tx-time">${formatTime(tx.timestamp)}</div>
        </div>
        <div class="tx-amount ${tx.type}">
          ${tx.type === 'send' ? '-' : '+'}${tx.amountSats.toLocaleString()} sats
        </div>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = '<div class="empty-state">Could not load transactions</div>';
  }
}

async function loadSites() {
  const list = document.getElementById('sites-list');
  try {
    const permissions = await bg('GET_PERMISSIONS');
    const origins = Object.entries(permissions).filter(([, v]) => v.granted);
    if (!origins.length) {
      list.innerHTML = '<div class="empty-state">No sites connected</div>';
      return;
    }
    list.innerHTML = origins.map(([origin]) => `
      <div class="site-item">
        <span class="site-origin">${escapeHtml(origin)}</span>
        <button class="site-revoke" data-origin="${escapeHtml(origin)}">Revoke</button>
      </div>
    `).join('');

    list.querySelectorAll('.site-revoke').forEach(btn => {
      btn.addEventListener('click', async () => {
        await bg('REVOKE_PERMISSION', { origin: btn.dataset.origin });
        loadSites();
        showToast('Permission revoked');
      });
    });
  } catch {}
}

// ─── Approval Screen ──────────────────────────────────────────────────────

async function initApprovalScreen(requestId) {
  try {
    const { data } = await bg('GET_PENDING_APPROVAL', { requestId });
    if (!data) { window.close(); return; }
    showApprovalFor(requestId, data);
  } catch {
    window.close();
  }
}

function showApprovalFor(requestId, data) {
  showScreen('screen-approval');
  hideAllPanels();

  const icons = { connect: '🔗', payInvoice: '⚡', signMessage: '✎' };
  const titles = { connect: 'Connection Request', payInvoice: 'Payment Request', signMessage: 'Sign Message' };

  document.getElementById('approval-icon').textContent = icons[data.type] || '❓';
  document.getElementById('approval-title').textContent = titles[data.type] || 'Request';
  document.getElementById('approval-origin').textContent = data.origin || 'Unknown';

  const details = document.getElementById('approval-details');
  details.innerHTML = '';

  if (data.type === 'connect') {
    details.innerHTML = `
      <div class="approval-row">
        <span class="label">Requesting Access To</span>
        <span class="value">${escapeHtml(data.origin)}</span>
      </div>
      <div class="approval-row">
        <span class="label">Permissions</span>
        <span class="value">View balance, create invoices, request payments</span>
      </div>
    `;
  } else if (data.type === 'payInvoice') {
    details.innerHTML = `
      <div class="approval-row">
        <span class="label">Amount</span>
        <span class="value highlight">${(data.amountSats || 0).toLocaleString()} sats</span>
      </div>
      <div class="approval-row">
        <span class="label">Description</span>
        <span class="value">${escapeHtml(data.description || '–')}</span>
      </div>
      <div class="approval-row">
        <span class="label">Invoice</span>
        <span class="value" style="font-size:10px;word-break:break-all">${escapeHtml((data.invoice || '').slice(0, 60))}…</span>
      </div>
      <div class="approval-row">
        <span class="label">Max Fee</span>
        <span class="value">${data.maxFeeSats || 100} sats</span>
      </div>
    `;
  } else if (data.type === 'signMessage') {
    details.innerHTML = `
      <div class="approval-row">
        <span class="label">Message to Sign</span>
        <span class="value">${escapeHtml(data.message || '')}</span>
      </div>
      <div class="approval-row">
        <span class="label">Signed With</span>
        <span class="value">Your Bitcoin private key</span>
      </div>
    `;
  }

  document.getElementById('btn-approve').onclick = async () => {
    await bg('APPROVAL_RESPONSE', { requestId, approved: true });
    window.close();
  };
  document.getElementById('btn-reject').onclick = async () => {
    await bg('APPROVAL_RESPONSE', { requestId, approved: false });
    window.close();
  };
}

// ─── Event Listeners ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init();

  // ── Setup screen ──
  document.getElementById('btn-create-wallet').addEventListener('click', () =>
    showScreen('screen-create'));

  document.getElementById('btn-import-wallet').addEventListener('click', () =>
    showScreen('screen-import'));

  // ── Back buttons ──
  document.querySelectorAll('.btn-back').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.target));
  });

  // ── Create wallet ──
  document.getElementById('btn-do-create').addEventListener('click', async () => {
    const password = document.getElementById('create-password').value;
    const confirm = document.getElementById('create-password-confirm').value;
    if (password.length < 8) return showToast('Password must be at least 8 characters', 'error');
    if (password !== confirm) return showToast('Passwords do not match', 'error');
    try {
      const { mnemonic } = await bg('CREATE_WALLET', { password });
      showSeedPhrase(mnemonic);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Seed phrase done ──
  document.getElementById('btn-seed-done').addEventListener('click', async () => {
    await loadMainScreen();
  });

  // ── Import wallet ──
  document.getElementById('btn-do-import').addEventListener('click', async () => {
    const mnemonic = document.getElementById('import-mnemonic').value.trim();
    const password = document.getElementById('import-password').value;
    if (!mnemonic || mnemonic.split(' ').length < 12) {
      return showToast('Please enter a valid 12-word seed phrase', 'error');
    }
    if (password.length < 8) return showToast('Password must be at least 8 characters', 'error');
    try {
      // Create wallet from mnemonic
      await bg('CREATE_WALLET', { password, mnemonic });
      await loadMainScreen();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Unlock ──
  document.getElementById('btn-unlock').addEventListener('click', async () => {
    const password = document.getElementById('unlock-password').value;
    try {
      await bg('UNLOCK_WALLET', { password });
      await loadMainScreen();
    } catch (err) {
      showToast('Wrong password', 'error');
    }
  });
  document.getElementById('unlock-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-unlock').click();
  });

  // ── Lock ──
  document.getElementById('btn-lock').addEventListener('click', async () => {
    await bg('LOCK_WALLET');
    showScreen('screen-unlock');
  });

  // ── Copy address ──
  document.getElementById('btn-copy-address').addEventListener('click', () => {
    const addr = document.getElementById('display-address').dataset.full;
    navigator.clipboard.writeText(addr || '');
    showToast('Address copied!', 'success');
  });

  // ── Tabs ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab)?.classList.add('active');
    });
  });

  // ── Panels: open ──
  document.getElementById('btn-send-tab').addEventListener('click', () => showPanel('panel-send'));
  document.getElementById('btn-receive-tab').addEventListener('click', () => showPanel('panel-receive'));
  document.getElementById('btn-sign-tab').addEventListener('click', () => showPanel('panel-sign'));

  // ── Panels: close ──
  document.querySelectorAll('.btn-close-panel').forEach(btn => {
    btn.addEventListener('click', hideAllPanels);
  });

  // ── Send: decode invoice on input ──
  document.getElementById('send-invoice-input').addEventListener('input', debounce(async (e) => {
    const invoice = e.target.value.trim();
    const preview = document.getElementById('send-invoice-preview');
    if (!invoice.startsWith('lnbc')) { preview.classList.add('hidden'); return; }
    // Attempt to decode (background)
    try {
      // Quick local decode attempt
      const match = invoice.match(/^lnbc(\d+)n/);
      if (match) {
        document.getElementById('preview-amount').textContent = parseInt(match[1]).toLocaleString() + ' sats';
        document.getElementById('preview-desc').textContent = '⚡ Lightning Payment';
        preview.classList.remove('hidden');
      }
    } catch {}
  }, 300));

  // ── Send: pay invoice ──
  document.getElementById('btn-do-send').addEventListener('click', async () => {
    const invoice = document.getElementById('send-invoice-input').value.trim();
    const maxFeeSats = parseInt(document.getElementById('send-max-fee').value) || 100;
    const resultEl = document.getElementById('send-result');
    if (!invoice) return showToast('Please enter an invoice', 'error');
    try {
      document.getElementById('btn-do-send').disabled = true;
      document.getElementById('btn-do-send').textContent = '⚡ Sending...';
      const result = await bg('PAY_INVOICE_MANUAL', { invoice, maxFeeSats });
      resultEl.className = 'result-box success';
      resultEl.innerHTML = `✅ Payment sent!<br>Preimage: <span style="font-size:10px">${result.preimage.slice(0, 32)}…</span><br>Fee: ${result.feeSats} sats`;
      resultEl.classList.remove('hidden');
      showToast('Payment successful!', 'success');
      setTimeout(() => loadBalance(), 500);
      setTimeout(() => loadTransactions(), 500);
    } catch (err) {
      resultEl.className = 'result-box error';
      resultEl.textContent = '❌ ' + err.message;
      resultEl.classList.remove('hidden');
    } finally {
      document.getElementById('btn-do-send').disabled = false;
      document.getElementById('btn-do-send').textContent = '⚡ Send Payment';
    }
  });

  // ── Receive: create invoice ──
  document.getElementById('btn-create-invoice').addEventListener('click', async () => {
    const amountSats = parseInt(document.getElementById('receive-amount').value);
    const description = document.getElementById('receive-description').value;
    if (!amountSats || amountSats < 1) return showToast('Enter a valid amount', 'error');
    try {
      const inv = await bg('CREATE_INVOICE', { amountSats, description });
      document.getElementById('invoice-output').value = inv.paymentRequest;
      document.getElementById('qr-placeholder').textContent = '▣'; // QR placeholder
      document.getElementById('invoice-result').classList.remove('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-copy-invoice').addEventListener('click', () => {
    const inv = document.getElementById('invoice-output').value;
    navigator.clipboard.writeText(inv);
    showToast('Invoice copied!', 'success');
  });

  // ── Sign message ──
  document.getElementById('btn-do-sign').addEventListener('click', async () => {
    const message = document.getElementById('sign-message-input').value.trim();
    const resultEl = document.getElementById('sign-result');
    if (!message) return showToast('Enter a message to sign', 'error');
    try {
      const sig = await bg('PAY_INVOICE_MANUAL', { _type: 'sign', message }); // handled differently
      // Actually call sign directly
      const state = await bg('GET_STATE');
      if (!state.unlocked) return showToast('Wallet locked', 'error');
      resultEl.className = 'result-box success';
      resultEl.textContent = 'Signature: sign requires approval – use window.bitcoin.signMessage() from a dApp.';
      resultEl.classList.remove('hidden');
    } catch {}
  });

  // ── Settings ──
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const host = document.getElementById('setting-lnd-host').value.trim();
    const macaroon = document.getElementById('setting-macaroon').value.trim();
    await bg('SAVE_SETTINGS', { lnd: { host, macaroonHex: macaroon } });
    showToast('Settings saved', 'success');
  });

  document.getElementById('btn-show-seed').addEventListener('click', async () => {
    showToast('For security, seed phrase can only be shown during setup.', 'error');
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function showSeedPhrase(mnemonic) {
  const words = mnemonic.split(' ');
  const grid = document.getElementById('seed-words');
  grid.innerHTML = words.map((word, i) => `
    <div class="seed-word">
      <span class="seed-word-num">${i + 1}</span>
      <span class="seed-word-text">${escapeHtml(word)}</span>
    </div>
  `).join('');
  showScreen('screen-seed');
}

function formatTime(timestamp) {
  if (!timestamp) return '–';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  if (diffMs < 60_000) return 'Just now';
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
  return date.toLocaleDateString();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

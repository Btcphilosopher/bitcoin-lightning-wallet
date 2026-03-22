# ⚡ Bolt Wallet — Bitcoin & Lightning Browser Extension

A MetaMask-style Bitcoin and Lightning Network wallet for Chrome/Chromium (Manifest V3).

---

## What It Does

- Injects `window.bitcoin` into every web page — like MetaMask's `window.ethereum`
- Lets dApps request payments, signatures, and account access
- Clean popup UI for wallet management
- Lightning Network support via mock backend (LND integration included)
- Secure key storage using Web Crypto API (AES-GCM + PBKDF2)

---

## Project Structure

```
bitcoin-lightning-wallet/
├── manifest.json          # Chrome MV3 manifest
├── background.js          # Service worker: wallet logic, routing
├── content.js             # Injected into pages: provides window.bitcoin
├── crypto/
│   ├── wallet.js          # secp256k1 keypairs, BIP39, signing
│   └── encryption.js      # AES-GCM encryption, PBKDF2 key derivation
├── lightning/
│   ├── mock.js            # Mock Lightning backend (development)
│   └── lnd.js             # Real LND REST API integration
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Popup controller
│   └── popup.css          # Styles
├── example-dapp/
│   └── index.html         # Example website integration
└── icons/
    └── (place icon files here)
```

---

## Loading the Extension in Chrome

### Step 1: Prepare Icons

Create placeholder icons (or use your own):
1. Create PNG icons at `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`
2. A simple orange lightning bolt on dark background works well

You can use any image editor, or generate them programmatically.

### Step 2: Load in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer Mode** (toggle in top-right corner)
3. Click **"Load unpacked"**
4. Select the `bitcoin-lightning-wallet` directory
5. The extension should appear with a ⚡ icon in your toolbar

### Step 3: First Run

1. Click the Bolt Wallet icon in the toolbar
2. Click **"Create New Wallet"**
3. Set a strong password (8+ characters)
4. **Save your 12-word seed phrase** — write it down offline
5. Click "I've saved it safely"
6. Your wallet is ready!

---

## Using the Example dApp

1. Open `example-dapp/index.html` in Chrome (after loading the extension)
2. You should see the console log at the bottom detect the wallet
3. Click **"Connect to Bolt Wallet"** — a popup will appear asking for approval
4. After connecting, you can:
   - Check your balance
   - Create and pay Lightning invoices
   - Sign messages with your Bitcoin key
   - View transaction history

---

## The `window.bitcoin` API

```javascript
// Check if Bolt Wallet is installed
if (typeof window.bitcoin !== 'undefined') {
  console.log('Bolt Wallet detected!');
}

// Listen for provider ready
window.addEventListener('bolt:ready', () => {
  console.log('Provider ready');
});

// ── Connect (request access) ─────────────────────────
const { address, publicKey } = await window.bitcoin.connect();

// ── Generic RPC interface (MetaMask-style) ────────────
const accounts = await window.bitcoin.request({ method: 'getAccounts' });
const balance  = await window.bitcoin.request({ method: 'getBalance' });

// ── Get balance ──────────────────────────────────────
const { sats, btc } = await window.bitcoin.getBalance();
// → { sats: 999000, msats: 999000000, btc: "0.00999000" }

// ── Pay a Lightning invoice ───────────────────────────
const result = await window.bitcoin.payInvoice(
  'lnbc1000n1p...',  // BOLT11 invoice
  100                 // max fee in sats
);
// → { preimage: "...", feeSats: 1, amountSats: 1000 }

// ── Create an invoice ─────────────────────────────────
const invoice = await window.bitcoin.createInvoice(
  1000,           // amount in sats
  'For coffee',   // description
  3600            // expiry in seconds
);
// → { paymentRequest: "lnbc1000n1p...", paymentHash: "...", ... }

// ── Sign a message ────────────────────────────────────
const sig = await window.bitcoin.signMessage('Hello World');
// → { r: "...", s: "...", signature: "..." }

// ── Get public key ────────────────────────────────────
const { publicKey, address } = await window.bitcoin.getPublicKey();

// ── Get transactions ──────────────────────────────────
const txs = await window.bitcoin.getTransactions(10);
```

---

## Connecting to a Real LND Node

1. Open the extension popup
2. Go to the **Settings** tab
3. Enter your LND REST endpoint, e.g. `https://my-node.local:8080`
4. Paste your admin macaroon (hex encoded)
5. Click **Save Settings**

To get your admin macaroon hex:
```bash
xxd -p ~/.lnd/data/chain/bitcoin/mainnet/admin.macaroon | tr -d '\n'
```

---

## Security Architecture

### Key Storage
- Private keys are encrypted with **AES-256-GCM**
- Encryption key derived from your password via **PBKDF2-SHA256** (600,000 iterations)
- The random salt + IV are stored alongside the ciphertext
- Wrong password = authentication failure (GCM auth tag mismatch)

### Permission Model
- Each website must request access via `window.bitcoin.connect()`
- User sees an approval popup with the requesting origin
- Approvals are stored per-origin in `chrome.storage.local`
- Users can revoke permissions at any time from the "Sites" tab

### Message Security
- Content script runs in `MAIN` world for `window.bitcoin` injection
- All sensitive operations go through the background service worker
- The page never has direct access to private keys or the password
- Auto-lock after 30 minutes of inactivity

---

## Architecture Notes

### Manifest V3 Considerations
- Background service worker (not persistent background page)
- No inline scripts allowed
- Content Security Policy enforced
- Uses `chrome.storage.local` (not localStorage)

### Production Improvements
For a production wallet, consider:
- **BIP32/BIP44** HD key derivation (from `@noble/secp256k1` + `@noble/hashes`)
- **LNURL** support for Lightning addresses
- **BOLT12** offers (recurring payments)
- Hardware wallet integration (Ledger/Trezor)
- QR code scanning for invoices
- Multi-account support
- Export/import in standard wallet formats

---

## Development

```bash
# No build step required — pure JS/HTML/CSS
# Just load the unpacked extension in Chrome

# For LND integration testing:
# 1. Run a local LND node (Polar is great for this: https://lightningpolar.com)
# 2. Configure host + macaroon in extension settings
# 3. The mock backend will be replaced automatically
```

---


/**
 * lightning/mock.js
 * Mock Lightning Network backend for development and testing.
 * Simulates LND-like responses without a real node.
 */

import { randomHex } from '../crypto/encryption.js';

/** In-memory balance in millisatoshis */
let balanceMsats = 1_000_000_000; // 1,000,000 sats = 0.01 BTC

/** In-memory transaction history */
let transactions = [
  {
    id: 'mock_tx_001',
    type: 'receive',
    amountSats: 50000,
    description: 'Initial funding',
    timestamp: Date.now() - 3600_000 * 24,
    status: 'settled',
    preimage: randomHex(32),
    paymentHash: randomHex(32),
  },
  {
    id: 'mock_tx_002',
    type: 'send',
    amountSats: 1000,
    description: 'Test payment',
    timestamp: Date.now() - 3600_000 * 2,
    status: 'settled',
    preimage: randomHex(32),
    paymentHash: randomHex(32),
  },
];

/** Pending invoices we've generated */
const pendingInvoices = new Map();

/**
 * Returns the wallet balance.
 * @returns {{ sats: number, msats: number, btc: string }}
 */
export async function getBalance() {
  return {
    sats: Math.floor(balanceMsats / 1000),
    msats: balanceMsats,
    btc: (balanceMsats / 1e11).toFixed(8),
  };
}

/**
 * Creates a BOLT11-style Lightning invoice (mocked).
 * @param {{ amountSats: number, description: string, expiry?: number }} opts
 * @returns {{ paymentRequest: string, paymentHash: string, expiry: number }}
 */
export async function createInvoice({ amountSats, description = '', expiry = 3600 }) {
  const paymentHash = randomHex(32);
  const preimage = randomHex(32);

  // Build a mock BOLT11 invoice string
  // Real BOLT11 uses bech32 encoding; this is a readable mock
  const invoice = buildMockBolt11(amountSats, paymentHash, description, expiry);

  pendingInvoices.set(paymentHash, {
    paymentHash,
    preimage,
    amountSats,
    description,
    expiry: Date.now() + expiry * 1000,
    status: 'pending',
    invoice,
  });

  return {
    paymentRequest: invoice,
    paymentHash,
    expiry: Date.now() + expiry * 1000,
    amountSats,
    description,
  };
}

/**
 * Pays a Lightning invoice (mocked).
 * Fails ~5% of the time to simulate real network conditions.
 * @param {{ invoice: string, maxFeeSats?: number }} opts
 * @returns {{ preimage: string, feeSats: number, amountSats: number }}
 */
export async function payInvoice({ invoice, maxFeeSats = 100 }) {
  // Decode the mock invoice
  const decoded = decodeMockBolt11(invoice);
  if (!decoded) throw new Error('Invalid invoice format');

  const { amountSats, paymentHash, description } = decoded;

  if (amountSats * 1000 > balanceMsats) {
    throw new Error(`Insufficient balance. Have ${Math.floor(balanceMsats / 1000)} sats, need ${amountSats} sats.`);
  }

  // Simulate network delay
  await sleep(800 + Math.random() * 400);

  // Simulate 5% failure rate
  if (Math.random() < 0.05) {
    throw new Error('Payment failed: no route found');
  }

  const feeSats = Math.max(1, Math.floor(amountSats * 0.001)); // 0.1% fee
  if (feeSats > maxFeeSats) {
    throw new Error(`Fee ${feeSats} sats exceeds max fee ${maxFeeSats} sats`);
  }

  const preimage = randomHex(32);
  balanceMsats -= (amountSats + feeSats) * 1000;

  const tx = {
    id: 'tx_' + randomHex(8),
    type: 'send',
    amountSats,
    feeSats,
    description: description || 'Lightning payment',
    timestamp: Date.now(),
    status: 'settled',
    preimage,
    paymentHash,
    invoice,
  };
  transactions.unshift(tx);

  return { preimage, feeSats, amountSats, paymentHash };
}

/**
 * Decodes a BOLT11 invoice to extract metadata.
 * @param {string} invoice
 * @returns {{ amountSats: number, paymentHash: string, description: string } | null}
 */
export function decodeBolt11(invoice) {
  return decodeMockBolt11(invoice);
}

/**
 * Fetches recent transactions.
 * @param {{ limit?: number }} opts
 * @returns {Array}
 */
export async function getTransactions({ limit = 20 } = {}) {
  return transactions.slice(0, limit);
}

/**
 * Looks up a payment by hash.
 * @param {string} paymentHash
 */
export async function getPayment(paymentHash) {
  return transactions.find(t => t.paymentHash === paymentHash) || null;
}

/**
 * Simulate receiving an incoming payment (for testing).
 * @param {{ amountSats: number, description?: string }}
 */
export async function simulateIncomingPayment({ amountSats, description = 'Incoming payment' }) {
  balanceMsats += amountSats * 1000;
  const tx = {
    id: 'tx_' + randomHex(8),
    type: 'receive',
    amountSats,
    feeSats: 0,
    description,
    timestamp: Date.now(),
    status: 'settled',
    preimage: randomHex(32),
    paymentHash: randomHex(32),
  };
  transactions.unshift(tx);
  return tx;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildMockBolt11(amountSats, paymentHash, description, expiry) {
  // Format: lnbc{amount}n1{hash16}{descB64}{expiry}
  const amountNano = amountSats * 1000; // to millisats... actually just encode sats
  const descB64 = btoa(description).replace(/=/g, '').slice(0, 20);
  return `lnbc${amountSats}n1p${paymentHash.slice(0, 16)}x${descB64}e${expiry}bolt`;
}

function decodeMockBolt11(invoice) {
  if (!invoice || !invoice.startsWith('lnbc')) return null;
  try {
    // Parse: lnbc{amount}n1p{hash16}x{desc}e{expiry}bolt
    const match = invoice.match(/^lnbc(\d+)n1p([0-9a-f]{16})x(.*)e(\d+)bolt$/);
    if (!match) return null;
    return {
      amountSats: parseInt(match[1], 10),
      paymentHash: match[2].padEnd(64, '0'),
      description: atob(match[3].padEnd(match[3].length + (4 - match[3].length % 4) % 4, '=')),
      expiry: parseInt(match[4], 10),
    };
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

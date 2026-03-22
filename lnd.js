/**
 * lightning/lnd.js
 * LND REST API integration.
 * Configure with your node's REST endpoint and macaroon.
 *
 * LND REST docs: https://lightning.engineering/api-docs/api/lnd/
 */

export class LNDClient {
  /**
   * @param {{ host: string, macaroonHex: string, tlsCert?: string }} config
   */
  constructor({ host, macaroonHex, tlsCert }) {
    this.host = host.replace(/\/$/, '');
    this.macaroonHex = macaroonHex;
    this.tlsCert = tlsCert;
  }

  /** Makes an authenticated LND REST request */
  async request(path, options = {}) {
    const url = `${this.host}${path}`;
    const headers = {
      'Grpc-Metadata-macaroon': this.macaroonHex,
      'Content-Type': 'application/json',
    };
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `LND request failed: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Returns wallet balance (on-chain + off-chain).
   */
  async getBalance() {
    const [chain, channel] = await Promise.all([
      this.request('/v1/balance/blockchain'),
      this.request('/v1/balance/channels'),
    ]);
    const sats = parseInt(channel.local_balance?.sat || '0', 10);
    return {
      sats,
      msats: sats * 1000,
      btc: (sats / 1e8).toFixed(8),
      onChainSats: parseInt(chain.confirmed_balance || '0', 10),
    };
  }

  /**
   * Creates a new Lightning invoice.
   * @param {{ amountSats: number, description: string, expiry?: number }}
   */
  async createInvoice({ amountSats, description = '', expiry = 3600 }) {
    const data = await this.request('/v1/invoices', {
      method: 'POST',
      body: JSON.stringify({
        value: amountSats,
        memo: description,
        expiry: expiry.toString(),
      }),
    });
    return {
      paymentRequest: data.payment_request,
      paymentHash: data.r_hash,
      expiry: Date.now() + expiry * 1000,
      amountSats,
      description,
    };
  }

  /**
   * Pays a BOLT11 Lightning invoice.
   * @param {{ invoice: string, maxFeeSats?: number }}
   */
  async payInvoice({ invoice, maxFeeSats = 100 }) {
    const data = await this.request('/v1/channels/transactions', {
      method: 'POST',
      body: JSON.stringify({
        payment_request: invoice,
        fee_limit: { fixed: maxFeeSats.toString() },
      }),
    });
    if (data.payment_error) {
      throw new Error(`Payment failed: ${data.payment_error}`);
    }
    return {
      preimage: data.payment_preimage,
      feeSats: parseInt(data.payment_route?.total_fees || '0', 10),
      amountSats: parseInt(data.payment_route?.total_amt || '0', 10),
    };
  }

  /**
   * Decodes a BOLT11 invoice.
   * @param {string} invoice
   */
  async decodeBolt11(invoice) {
    const data = await this.request(`/v1/payreq/${encodeURIComponent(invoice)}`);
    return {
      amountSats: parseInt(data.num_satoshis || '0', 10),
      description: data.description || '',
      paymentHash: data.payment_hash,
      destination: data.destination,
      expiry: parseInt(data.expiry || '3600', 10),
      timestamp: parseInt(data.timestamp || '0', 10),
    };
  }

  /**
   * Fetches recent payments and invoices.
   */
  async getTransactions({ limit = 20 } = {}) {
    const [payments, invoices] = await Promise.all([
      this.request('/v1/payments?max_payments=10&reversed=true'),
      this.request('/v1/invoices?reversed=true&num_max_invoices=10'),
    ]);

    const txs = [];

    for (const p of (payments.payments || []).slice(0, limit / 2)) {
      txs.push({
        id: p.payment_hash,
        type: 'send',
        amountSats: parseInt(p.value_sat || '0', 10),
        feeSats: parseInt(p.fee_sat || '0', 10),
        description: p.payment_request ? 'Lightning payment' : 'Keysend',
        timestamp: parseInt(p.creation_time_ns || '0', 10) / 1e6,
        status: p.status === 'SUCCEEDED' ? 'settled' : p.status.toLowerCase(),
        preimage: p.payment_preimage,
        paymentHash: p.payment_hash,
      });
    }

    for (const inv of (invoices.invoices || []).slice(0, limit / 2)) {
      if (inv.state === 'SETTLED') {
        txs.push({
          id: inv.r_hash,
          type: 'receive',
          amountSats: parseInt(inv.value || '0', 10),
          feeSats: 0,
          description: inv.memo || 'Incoming payment',
          timestamp: parseInt(inv.settle_date || '0', 10) * 1000,
          status: 'settled',
          preimage: inv.r_preimage,
          paymentHash: inv.r_hash,
        });
      }
    }

    return txs.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
}

/**
 * Creates an LND client from stored config.
 * Falls back to mock if no config present.
 */
export function createLNDClient(config) {
  if (!config?.host || !config?.macaroonHex) {
    throw new Error('LND config missing: host and macaroonHex required');
  }
  return new LNDClient(config);
}

/**
 * wallet.js
 * Bitcoin key management: secp256k1 keypairs, BIP39-style seed phrases,
 * address derivation, and message signing.
 *
 * NOTE: This file uses a pure-JS minimal secp256k1 implementation
 * suitable for a prototype. Production wallets should use audited libs.
 */

import { randomHex, sha256Hex } from './encryption.js';

// ─── BIP39 Word List (first 256 words for prototype) ───────────────────────
// In production, load the full 2048-word list.
const WORD_LIST = [
  'abandon','ability','able','about','above','absent','absorb','abstract',
  'absurd','abuse','access','accident','account','accuse','achieve','acid',
  'acoustic','acquire','across','act','action','actor','actress','actual',
  'adapt','add','addict','address','adjust','admit','adult','advance',
  'advice','aerobic','afford','afraid','again','age','agent','agree',
  'ahead','aim','air','airport','aisle','alarm','album','alcohol',
  'alert','alien','all','alley','allow','almost','alone','alpha',
  'already','also','alter','always','amateur','amazing','among','amount',
  'amused','analyst','anchor','ancient','anger','angle','angry','animal',
  'ankle','announce','annual','another','answer','antenna','antique','anxiety',
  'any','apart','apology','appear','apple','approve','april','arch',
  'arctic','area','arena','argue','arm','armed','armor','army',
  'around','arrange','arrest','arrive','arrow','art','artefact','artist',
  'artwork','ask','aspect','assault','asset','assist','assume','asthma',
  'athlete','atom','attack','attend','attitude','attract','auction','audit',
  'august','aunt','author','auto','autumn','average','avocado','avoid',
  'awake','aware','away','awesome','awful','awkward','axis','baby',
  'balance','bamboo','banana','banner','bar','barely','bargain','barrel',
  'base','basic','basket','battle','beach','beauty','because','become',
  'beef','before','begin','behave','behind','believe','below','belt',
  'bench','benefit','best','betray','better','between','beyond','bicycle',
  'bid','bike','bind','biology','bird','birth','bitter','black',
  'blade','blame','blanket','blast','bleak','bless','blind','blood',
  'blossom','blouse','blue','blur','blush','board','boat','body',
  'boil','bomb','bone','book','boost','border','boring','borrow',
  'boss','bottom','bounce','box','boy','bracket','brain','brand',
  'brave','breeze','brick','bridge','brief','bright','bring','brisk',
  'broccoli','broken','bronze','broom','brother','brown','brush','bubble',
  'buddy','budget','buffalo','build','bulb','bulk','bullet','bundle',
  'bunker','burden','burger','burst','bus','business','busy','butter',
  'buyer','buzz','cabbage','cabin','cable','cactus','cage','cake',
  'call','calm','camera','camp','canal','cancel','candy','cannon',
  'canvas','canyon','capable','capital','captain','car','carbon','card',
];

// Pad to power of 2 ≥ 256 (already 256 entries above, enough for prototype)

/**
 * Generates a 12-word mnemonic seed phrase from random entropy.
 * @returns {string} space-separated 12 words
 */
export function generateMnemonic() {
  const words = [];
  for (let i = 0; i < 12; i++) {
    const idx = crypto.getRandomValues(new Uint32Array(1))[0] % WORD_LIST.length;
    words.push(WORD_LIST[idx]);
  }
  return words.join(' ');
}

// ─── Minimal secp256k1 implementation (prototype-grade) ────────────────────
// For production use: @noble/secp256k1 or bitcoinjs-lib

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function modP(n) { return ((n % P) + P) % P; }
function modN(n) { return ((n % N) + N) % N; }

function pointAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  if (x1 === x2 && y1 !== y2) return null;
  let m;
  if (x1 === x2) {
    m = modP(3n * x1 * x1 * modPow(2n * y1, P - 2n, P));
  } else {
    m = modP((y2 - y1) * modPow(x2 - x1, P - 2n, P));
  }
  const x3 = modP(m * m - x1 - x2);
  const y3 = modP(m * (x1 - x3) - y1);
  return [x3, y3];
}

function modPow(base, exp, mod) {
  base = ((base % mod) + mod) % mod;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % mod;
    base = base * base % mod;
    exp >>= 1n;
  }
  return result;
}

function scalarMul(k, point) {
  let result = null;
  let addend = point;
  k = ((k % N) + N) % N;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

const G = [Gx, Gy];

function bigIntToHex(n, len = 64) {
  return n.toString(16).padStart(len, '0');
}

function hexToBigInt(hex) {
  return BigInt('0x' + hex);
}

/**
 * Generates a new secp256k1 keypair.
 * @returns {{ privateKey: string, publicKey: string, address: string }}
 */
export async function generateKeypair() {
  // Generate random 32-byte private key, ensure it's in [1, N-1]
  let privHex;
  do {
    privHex = randomHex(32);
  } while (hexToBigInt(privHex) === 0n || hexToBigInt(privHex) >= N);

  const privBig = hexToBigInt(privHex);
  const pub = scalarMul(privBig, G);
  const pubHex = '04' + bigIntToHex(pub[0]) + bigIntToHex(pub[1]);

  // Derive a simple P2PKH-style address (hash160 of public key)
  const address = await deriveAddress(pubHex);

  return {
    privateKey: privHex,
    publicKey: pubHex,
    address,
  };
}

/**
 * Derives a Bitcoin-like address from a hex public key.
 * Uses SHA-256 of the pubkey as a simplified address (prototype).
 * @param {string} pubKeyHex
 * @returns {Promise<string>}
 */
export async function deriveAddress(pubKeyHex) {
  const hash = await sha256Hex(pubKeyHex);
  // Prefix with '1' to mimic mainnet P2PKH address format
  return 'bc1' + hash.slice(0, 38);
}

/**
 * Signs a message with a private key using ECDSA-like scheme.
 * Returns a deterministic signature as { r, s } hex strings.
 * @param {string} message
 * @param {string} privateKeyHex
 * @returns {Promise<{ r: string, s: string, signature: string }>}
 */
export async function signMessage(message, privateKeyHex) {
  const msgHash = await sha256Hex('Bitcoin Signed Message:\n' + message);
  const z = hexToBigInt(msgHash);
  const d = hexToBigInt(privateKeyHex);

  // RFC 6979 deterministic k (simplified)
  const kHex = await sha256Hex(privateKeyHex + msgHash);
  const k = modN(hexToBigInt(kHex));

  const R = scalarMul(k, G);
  const r = modN(R[0]);
  const kInv = modPow(k, N - 2n, N);
  const s = modN(kInv * (z + r * d));

  return {
    r: bigIntToHex(r),
    s: bigIntToHex(s),
    signature: bigIntToHex(r) + bigIntToHex(s),
  };
}

/**
 * Verifies an ECDSA signature.
 * @param {string} message
 * @param {string} signatureHex - r+s concatenated (128 hex chars)
 * @param {string} publicKeyHex
 * @returns {Promise<boolean>}
 */
export async function verifySignature(message, signatureHex, publicKeyHex) {
  try {
    const msgHash = await sha256Hex('Bitcoin Signed Message:\n' + message);
    const z = hexToBigInt(msgHash);
    const r = hexToBigInt(signatureHex.slice(0, 64));
    const s = hexToBigInt(signatureHex.slice(64, 128));

    const sInv = modPow(s, N - 2n, N);
    const u1 = modN(z * sInv);
    const u2 = modN(r * sInv);

    // Parse public key (uncompressed: 04 + x + y)
    const px = hexToBigInt(publicKeyHex.slice(2, 66));
    const py = hexToBigInt(publicKeyHex.slice(66, 130));

    const point = pointAdd(scalarMul(u1, G), scalarMul(u2, [px, py]));
    return modN(point[0]) === r;
  } catch {
    return false;
  }
}

/**
 * Derives a keypair from a mnemonic (simplified – not BIP32/BIP44).
 * In production, use BIP32 HD derivation.
 * @param {string} mnemonic
 * @returns {Promise<{ privateKey: string, publicKey: string, address: string }>}
 */
export async function keypairFromMnemonic(mnemonic) {
  const seed = await sha256Hex(mnemonic + ':bolt-wallet-v1');
  const privBig = modN(hexToBigInt(seed));
  const privHex = bigIntToHex(privBig);
  const pub = scalarMul(privBig, G);
  const pubHex = '04' + bigIntToHex(pub[0]) + bigIntToHex(pub[1]);
  const address = await deriveAddress(pubHex);
  return { privateKey: privHex, publicKey: pubHex, address };
}

/**
 * encryption.js
 * Secure storage using Web Crypto API (AES-GCM + PBKDF2)
 * All private keys are encrypted at rest with a user password.
 */

const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;

/**
 * Derives a 256-bit AES-GCM key from a password + salt using PBKDF2-SHA256.
 * @param {string} password
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a plaintext string with AES-GCM.
 * Returns a Base64-encoded payload: salt | iv | ciphertext
 * @param {string} plaintext
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function encrypt(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt);

  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );

  // Pack: [salt (32)] [iv (12)] [ciphertext (n)]
  const packed = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.byteLength);
  packed.set(salt, 0);
  packed.set(iv, SALT_LENGTH);
  packed.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);

  return btoa(String.fromCharCode(...packed));
}

/**
 * Decrypts an AES-GCM encrypted Base64 payload.
 * Throws if the password is wrong (authentication tag mismatch).
 * @param {string} b64Payload
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function decrypt(b64Payload, password) {
  const packed = Uint8Array.from(atob(b64Payload), c => c.charCodeAt(0));
  const salt = packed.slice(0, SALT_LENGTH);
  const iv = packed.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = packed.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveKey(password, salt);
  const dec = new TextDecoder();

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return dec.decode(plaintext);
  } catch {
    throw new Error('Decryption failed – wrong password or corrupted vault.');
  }
}

/**
 * Computes SHA-256 of a message and returns hex string.
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function sha256Hex(message) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(message));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generates cryptographically random bytes as a hex string.
 * @param {number} length – byte count
 * @returns {string}
 */
export function randomHex(length = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

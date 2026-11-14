import { timingSafeEqual } from 'node:crypto';

const ITERATIONS = 210000;

async function hashWithPBKDF2(password, salt, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    512
  );
  return arrayToHex(new Uint8Array(bits));
}

function arrayToHex(arr) {
  return Array.from(arr).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generateSalt() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return arrayToHex(array);
}

export async function hashPassword(password) {
  const salt = generateSalt();
  const hash = await hashWithPBKDF2(password, salt, ITERATIONS);
  return `${ITERATIONS}:${salt}:${hash}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  let iterations = ITERATIONS;
  let salt;
  let key;
  if (parts.length === 3) {
    iterations = Number(parts[0]) || ITERATIONS;
    salt = parts[1];
    key = parts[2];
  } else {
    // Legacy scaffold format: salt:hash at 100k iterations.
    iterations = 100000;
    [salt, key] = parts;
  }
  if (!salt || !key) return false;
  const hash = await hashWithPBKDF2(password, salt, iterations);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(key, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

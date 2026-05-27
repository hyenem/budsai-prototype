// Ed25519 keypair utilities — browser side.
//
// Matches shared/python/key.py byte-for-byte:
//   - 32-byte raw private/public keys
//   - base64url encoding (no padding)
//   - same signature scheme
//
// Uses @noble/ed25519 from esm.sh so this file works without any
// build step — just import it from a <script type="module">.
//
// We pin v1.7.3 specifically because it bundles its own sha512;
// v2.x splits that into a separate package and the extra round-trip
// to esm.sh has hung intermittently in production.

import * as ed from "https://esm.sh/@noble/ed25519@1.7.3";

// ---------- base64url ----------
export function b64uEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- keypair ----------
export class Ed25519KeyPair {
  constructor(privateRaw, publicRaw) {
    this.privateRaw = privateRaw;
    this.publicRaw = publicRaw;
  }
  get privateB64() { return b64uEncode(this.privateRaw); }
  get publicB64()  { return b64uEncode(this.publicRaw); }

  async sign(messageBytes) {
    return await ed.sign(messageBytes, this.privateRaw);  // Uint8Array(64)
  }
  async signB64(messageBytes) {
    return b64uEncode(await this.sign(messageBytes));
  }
}

export async function generateKeypair() {
  const privateRaw = ed.utils.randomPrivateKey();         // 32 bytes
  const publicRaw  = await ed.getPublicKey(privateRaw);    // 32 bytes
  return new Ed25519KeyPair(privateRaw, publicRaw);
}

// Persist + reload across page refreshes
const LS_KEY = "budsai.devkey.v1";

export async function loadOrCreateKeypair() {
  const stored = localStorage.getItem(LS_KEY);
  if (stored) {
    try {
      const { priv, pub } = JSON.parse(stored);
      return new Ed25519KeyPair(b64uDecode(priv), b64uDecode(pub));
    } catch { /* fall through */ }
  }
  const kp = await generateKeypair();
  localStorage.setItem(LS_KEY, JSON.stringify({
    priv: kp.privateB64,
    pub:  kp.publicB64,
  }));
  return kp;
}

export async function verify(publicB64, messageBytes, signatureB64) {
  try {
    return await ed.verify(b64uDecode(signatureB64), messageBytes, b64uDecode(publicB64));
  } catch { return false; }
}

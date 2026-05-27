// Ed25519 keypair utilities — browser side.
//
// Matches shared/python/key.py byte-for-byte:
//   - 32-byte raw private/public keys
//   - base64url encoding (no padding)
//   - same signature scheme
//
// Uses @noble/ed25519 from esm.sh so this file works without any
// build step — just import it from a <script type="module">.

import * as ed from "https://esm.sh/@noble/ed25519@2.1.0";
import { sha512 } from "https://esm.sh/@noble/hashes@1.4.0/sha512";

// noble/ed25519 v2+ requires the host to supply sha512 (browsers don't
// expose it via WebCrypto for arbitrary input).
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

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

  sign(messageBytes) {
    return ed.sign(messageBytes, this.privateRaw);  // returns Uint8Array(64)
  }
  signB64(messageBytes) {
    return b64uEncode(this.sign(messageBytes));
  }
}

export function generateKeypair() {
  const privateRaw = ed.utils.randomPrivateKey();   // 32 bytes
  const publicRaw  = ed.getPublicKey(privateRaw);    // 32 bytes
  return new Ed25519KeyPair(privateRaw, publicRaw);
}

// Persist + reload across page refreshes
const LS_KEY = "budsai.devkey.v1";

export function loadOrCreateKeypair() {
  const stored = localStorage.getItem(LS_KEY);
  if (stored) {
    try {
      const { priv, pub } = JSON.parse(stored);
      return new Ed25519KeyPair(b64uDecode(priv), b64uDecode(pub));
    } catch { /* fall through */ }
  }
  const kp = generateKeypair();
  localStorage.setItem(LS_KEY, JSON.stringify({
    priv: kp.privateB64,
    pub:  kp.publicB64,
  }));
  return kp;
}

export function verify(publicB64, messageBytes, signatureB64) {
  try {
    return ed.verify(b64uDecode(signatureB64), messageBytes, b64uDecode(publicB64));
  } catch { return false; }
}

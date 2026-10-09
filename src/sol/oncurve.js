/**
 * Is a 32-byte key a point on the ed25519 curve? A person's wallet is (a public key); an address a program controls (a pool,
 * a vault, a PDA) is made off the curve on purpose, so no private key can exist for it. Same test as Solana's PublicKey.isOnCurve:
 * does y decode to a curve point, i.e. is (y² − 1) / (d·y² + 1) a square? Pure BigInt maths, no dependencies (src/chain.js
 * re-exports it; src/sol/pda.js uses it for findProgramAddress).
 */
/* A normal wallet address is an ed25519 public key: a point on the curve. Addresses controlled by a
 * program (pools, bonding curves, vaults, lockers, on any exchange, Raydium LaunchLab's included)
 * are made off the curve on purpose, so no private key can exist for them. Same test as Solana's
 * PublicKey.isOnCurve: does y decode to a curve point, i.e. is (y² − 1) / (d·y² + 1) a square? */
const P = (1n << 255n) - 19n;
const modP = (a) => ((a % P) + P) % P;
const powP = (b, e) => { let r = 1n; b = modP(b); for (; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P; return r; };
const D = modP(-121665n * powP(121666n, P - 2n));
export function isOnCurve(bytes) {
  if (!bytes || bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y = modP(y & ((1n << 255n) - 1n));
  const y2 = (y * y) % P, u = modP(y2 - 1n), v = modP(D * y2 + 1n);
  const x = (((u * powP(v, 3n)) % P) * powP(u * powP(v, 7n), (P - 5n) / 8n)) % P; // RFC 8032 §5.1.3
  const vx2 = (((v * x) % P) * x) % P;
  return vx2 === u || vx2 === modP(-u);
}

// Shared helpers for the launchpad scripts: keys by path (never printed),
// cluster detection with a mainnet guard, and sending instruction lists built
// by the SDK as v0 transactions with confirmation and readable errors.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import web3 from '@solana/web3.js';
import { toV0Transaction, requiredSigners } from '../../sdk/launchpad/trade.mts';

const { Connection, Keypair } = web3;
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** Read a keypair file. The secret never leaves this process and is never printed. */
export function loadKeypair(path) {
  if (!existsSync(path)) throw new Error(`missing key file ${path} (create it with: solana-keygen new --no-bip39-passphrase --silent --outfile ${path})`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

export async function connect(rpc) {
  const connection = new Connection(rpc, 'confirmed');
  const genesis = await connection.getGenesisHash();
  const cluster = genesis === MAINNET_GENESIS ? 'mainnet' : genesis === DEVNET_GENESIS ? 'devnet' : 'local';
  return { connection, genesis, cluster };
}

/** Refuse to send on mainnet unless the owner passed --mainnet on his own machine. */
export function guardMainnet(cluster, allowMainnet, what) {
  if (cluster === 'mainnet' && !allowMainnet) throw new Error(`${what}: this RPC is mainnet; add --mainnet to send real transactions (the owner, on his own machine)`);
}

export function explorer(kind, id, cluster) {
  const q = cluster === 'mainnet' ? '' : cluster === 'devnet' ? '?cluster=devnet' : `?cluster=custom&customUrl=${encodeURIComponent('http://127.0.0.1:18899')}`;
  return `https://explorer.solana.com/${kind}/${id}${q}`;
}

function errorText(e) {
  const logs = e?.logs ?? e?.transactionLogs ?? [];
  return `${e?.message ?? e}${logs.length ? `\n    ${logs.slice(-8).join('\n    ')}` : ''}`;
}

/**
 * Send kit-shaped instructions as one v0 transaction paid by `payer`, signed
 * by whichever of `signers` the instructions need; wait for confirmation.
 * A transaction that expires without landing (dropped by the network) is
 * signed again with a fresh blockhash and resent, up to `attempts` times;
 * that is safe because an expired transaction can never land later.
 * Returns { signature, bytes }. Throws with the program logs on failure.
 */
export async function send(connection, { payer, signers = [], ixs, cuLimit = 200_000, luts = [], label = 'tx', attempts = 3 }) {
  const need = new Set(requiredSigners(payer.publicKey.toBase58(), ixs));
  const keys = [payer, ...signers].filter((k, i, all) => need.has(k.publicKey.toBase58()) && all.findIndex((x) => x.publicKey.equals(k.publicKey)) === i);
  const missing = [...need].filter((a) => !keys.some((k) => k.publicKey.toBase58() === a));
  if (missing.length) throw new Error(`${label}: no key for required signer(s) ${missing.join(', ')}`);
  for (let attempt = 1; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = toV0Transaction({ payer: payer.publicKey.toBase58(), instructions: ixs, blockhash, lookupTables: luts, cuLimit });
    tx.sign(keys);
    let signature;
    try {
      signature = await connection.sendTransaction(tx, { maxRetries: 5 });
    } catch (e) {
      throw new Error(`${label} refused: ${errorText(e)}`);
    }
    let res;
    try {
      res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    } catch (e) {
      if (e?.name === 'TransactionExpiredBlockheightExceededError' && attempt < attempts) {
        console.error(`  ${label}: dropped by the network (blockhash expired), sending again`);
        continue;
      }
      throw e;
    }
    if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)} (${signature})`);
    return { signature, bytes: tx.serialize().length };
  }
}

/** Simulate (nothing is sent): returns the error and the last logs, for steps that must be refused. */
export async function simulate(connection, { payer, ixs, cuLimit = 200_000, luts = [] }) {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = toV0Transaction({ payer: payer.publicKey.toBase58(), instructions: ixs, blockhash, lookupTables: luts, cuLimit });
  const r = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  return { err: r.value.err, logs: (r.value.logs ?? []).slice(-6), unitsConsumed: r.value.unitsConsumed };
}

/** A small JSON state file so a long demo can be resumed; it holds only public data. */
export function stateFile(path) {
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { steps: {}, addresses: {} };
  const save = () => writeFileSync(path, `${JSON.stringify(state, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  return { state, save };
}

export const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

#!/usr/bin/env node
// The dev wallet's platform fees: list everything waiting for it in every
// Vicinity Meteora pool and build the claims (LAUNCHPAD-DESIGN.md 11.3).
// Only the dev wallet 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN can sign them.
//
// Usage, from solana/:
//   node scripts/launchpad/claim-platform-fees.mjs --rpc <url> [--out plan.json]
//       read only: prints the plan; --out writes the UNSIGNED transactions
//       (base64, with a fresh blockhash: sign within about a minute) for a
//       signing page that calls the wallet's signAllTransactions
//   node scripts/launchpad/claim-platform-fees.mjs --rpc <url> --keypair <dev wallet key file> --send [--mainnet]
//       the owner, on his own machine: signs and sends; --mainnet is required on mainnet
// The key file is read, never printed.
import { writeFileSync } from 'node:fs';
import { planPlatformFeeClaims } from '../../sdk/launchpad/platform-fees.mts';
import { toV0Transaction } from '../../sdk/launchpad/trade.mts';
import { connectionReader } from '../../sdk/launchpad/keeper.mjs';
import { ADDRESSES } from '../../sdk/launchpad/pda.mjs';
import { connect, guardMainnet, loadKeypair, send, explorer, json } from './lib.mjs';

function parseArgs(argv) {
  const a = { send: false, mainnet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--rpc') a.rpc = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--keypair') a.keypair = argv[++i];
    else if (k === '--send') a.send = true;
    else if (k === '--mainnet') a.mainnet = true;
    else throw new Error(`unknown option ${k}`);
  }
  if (!a.rpc) throw new Error('usage: claim-platform-fees.mjs --rpc <url> [--out plan.json] [--keypair <path> --send [--mainnet]]');
  if (a.send && !a.keypair) throw new Error('--send needs --keypair (the dev wallet)');
  return a;
}

const args = parseArgs(process.argv.slice(2));
const { connection, cluster } = await connect(args.rpc);
const plan = await planPlatformFeeClaims(connectionReader(connection));
const summary = {
  cluster, devWallet: ADDRESSES.feeRecipient,
  claims: plan.claims.map((c) => ({ kind: c.kind, pool: c.pool, coin: c.mint, amount: String(c.amount), unit: c.unit })),
  totals: plan.totals, transactions: plan.transactions.map((t) => ({ label: t.label, bytes: t.bytes, cuLimit: t.cuLimit })),
};
if (args.out) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const txs = plan.transactions.map((t) => Buffer.from(toV0Transaction({ payer: ADDRESSES.feeRecipient, instructions: t.instructions, blockhash, cuLimit: t.cuLimit }).serialize()).toString('base64'));
  writeFileSync(args.out, `${json({ ...summary, blockhash, lastValidBlockHeight, unsignedTransactions: txs })}\n`);
  summary.written = args.out;
}
if (args.send) {
  guardMainnet(cluster, args.mainnet, 'claim-platform-fees');
  const kp = loadKeypair(args.keypair);
  if (kp.publicKey.toBase58() !== ADDRESSES.feeRecipient) throw new Error('the key file is not the dev wallet');
  summary.sent = [];
  for (const t of plan.transactions) {
    const r = await send(connection, { payer: kp, ixs: t.instructions, cuLimit: t.cuLimit, label: t.label });
    summary.sent.push({ label: t.label, signature: r.signature, explorer: explorer('tx', r.signature, cluster) });
  }
}
console.log(json(summary));

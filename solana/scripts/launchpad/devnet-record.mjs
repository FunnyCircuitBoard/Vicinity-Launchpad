#!/usr/bin/env node
// Turns the devnet demo's state file (public data only) into the Markdown
// tables of LAUNCHPAD-DEVNET.md: every address and every transaction with an
// explorer link, its size, and the compute units and fee the cluster recorded.
// Read-only: it sends nothing.
//
// Usage, from solana/:
//   node scripts/launchpad/devnet-record.mjs scripts/launchpad/devnet-demo-state.json [--rpc <url>] [--no-meta]
import { readFileSync } from 'node:fs';
import web3 from '@solana/web3.js';

const [path, ...rest] = process.argv.slice(2);
if (!path) throw new Error('usage: devnet-record.mjs <state.json> [--rpc <url>] [--no-meta]');
const rpc = rest.includes('--rpc') ? rest[rest.indexOf('--rpc') + 1] : 'https://api.devnet.solana.com';
const noMeta = rest.includes('--no-meta');
const s = JSON.parse(readFileSync(path, 'utf8'));
if (s.cluster !== 'devnet') throw new Error(`this record is for devnet; the state file says ${s.cluster}`);
const conn = new web3.Connection(rpc, 'confirmed');
const link = (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
const cell = (x) => String(x).replace(/\|/g, '/');

const out = ['| name | address |', '|---|---|'];
for (const [name, a] of Object.entries(s.addresses)) out.push(`| ${name} | [\`${a}\`](${link('address', a)}) |`);
out.push('', '| step | what | signature | bytes | compute units | fee (lamports) |', '|---|---|---|---|---|---|');
for (const [name, st] of Object.entries(s.steps)) {
  for (const t of st.txs ?? []) {
    let cu = '', fee = '';
    if (!noMeta) {
      for (let i = 0; i < 3 && cu === ''; i++) {
        try {
          const tx = await conn.getTransaction(t.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
          if (tx?.meta) { cu = String(tx.meta.computeUnitsConsumed ?? ''); fee = String(tx.meta.fee); }
        } catch { /* public RPC hiccup: retry */ }
        if (cu === '') await new Promise((r) => setTimeout(r, 700));
      }
    }
    out.push(`| ${name} | ${cell(t.label)} | [\`${t.signature.slice(0, 10)}…\`](${link('tx', t.signature)}) | ${t.bytes} | ${cu} | ${fee} |`);
  }
}
console.log(out.join('\n'));

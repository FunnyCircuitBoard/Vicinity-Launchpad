#!/usr/bin/env node
// Vicinity keeper ("crank"): graduates every Vicinity coin whose curve is
// complete, sends the unsold dust to the dev wallet, collects the city's share
// of fees and of the graduation surplus, and forwards the holders' share to the
// city's vicinity_rewards vault (LAUNCHPAD-DESIGN.md 10.2 and 12.1).
//
// Every step is permissionless. The keeper wallet only pays network fees and
// rent (about 0.03 SOL per graduation, 0.002 SOL once per graduated coin for
// the dev wallet's coin account, and tiny fees for the daily run). It receives
// nothing and can move nobody's money.
//
// Usage, from solana/:
//   node scripts/launchpad/crank.mjs --rpc <url> --payer <address>              plan only (no key needed)
//   node scripts/launchpad/crank.mjs --rpc <url> --keypair <path> --send        one full pass
//   node scripts/launchpad/crank.mjs --rpc <url> --keypair <path> --send --loop
//        graduation pass every minute, full pass (pool fees, forwards) once a day
// Options:
//   --minute     only the steps that should not wait: graduation, leftover, surplus
//   --mainnet    required to --send on mainnet (the owner decides, on his own machine)
//
// The key file is read, never printed. Output is JSON: the plan, transaction
// sizes, and the signature of everything sent.
import { readFileSync } from 'node:fs';
import web3 from '@solana/web3.js';
import { connectionReader, runKeeper, toWeb3Instruction } from '../../sdk/launchpad/keeper.mjs';

const { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = web3;
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

function parseArgs(argv) {
  const a = { rpc: null, keypair: null, payer: null, send: false, loop: false, minute: false, mainnet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--rpc') a.rpc = argv[++i];
    else if (k === '--keypair') a.keypair = argv[++i];
    else if (k === '--payer') a.payer = argv[++i];
    else if (k === '--send') a.send = true;
    else if (k === '--loop') a.loop = true;
    else if (k === '--minute') a.minute = true;
    else if (k === '--mainnet') a.mainnet = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`unknown option ${k}`);
  }
  return a;
}

const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.rpc || (!args.keypair && !args.payer)) {
    console.log('usage: crank.mjs --rpc <url> (--payer <address> | --keypair <path> [--send]) [--minute] [--loop] [--mainnet]');
    process.exit(args.help ? 0 : 2);
  }
  if (args.send && !args.keypair) throw new Error('--send needs --keypair');
  const connection = new Connection(args.rpc, 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_GENESIS && args.send && !args.mainnet) {
    throw new Error('this RPC is mainnet: add --mainnet to send real transactions (owner only)');
  }
  const keeper = args.keypair ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, 'utf8')))) : null;
  const payer = keeper ? keeper.publicKey.toBase58() : new PublicKey(args.payer).toBase58();
  const reader = connectionReader(connection);
  const newSigner = async () => { const k = Keypair.generate(); return { address: k.publicKey.toBase58(), keypair: k }; };

  async function send(ixs, signers, { cu, label }) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: keeper.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs.map(toWeb3Instruction)],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([keeper, ...signers.map((s) => s.keypair)]);
    const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
    const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) throw new Error(`${label}: ${JSON.stringify(res.value.err)} (${signature})`);
    return signature;
  }

  async function pass(daily) {
    const report = await runKeeper({ reader, payer, newSigner, send, daily, dryRun: !args.send });
    console.log(json({
      at: new Date().toISOString(), cluster: genesis === MAINNET_GENESIS ? 'mainnet' : genesis, pass: daily ? 'daily' : 'minute',
      sent: args.send, coins: report.coins, steps: report.steps, notes: report.notes,
      transactions: report.transactions.map((t) => ({ label: t.label, bytes: t.bytes, cu: t.cu })),
      results: report.results.map((r) => (r.ok ? { label: r.label, signature: r.result } : r)),
    }));
  }

  if (!args.loop) return pass(!args.minute);
  // loop: graduation pass every minute, full pass at start and every 24 hours
  let lastDaily = 0;
  for (;;) {
    const daily = !args.minute && Date.now() - lastDaily >= 86_400_000;
    try { await pass(daily); if (daily) lastDaily = Date.now(); } catch (e) { console.error(`pass failed: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });

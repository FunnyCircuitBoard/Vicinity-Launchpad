#!/usr/bin/env node
// One-time launchpad setup (LAUNCHPAD-DESIGN.md 7.1 and 20): the Vicinity
// Meteora config, init_launchpad and the config allow-list.
//
// Plan only unless --send. On mainnet --send also needs --mainnet: that is
// the owner's decision, on his own machine. Key files are read, never printed.
//
//   node scripts/launchpad/setup.mjs config --rpc <url> --payer <key file> --config-keypair <fresh key file>
//        [--quote SOL|<mint>] [--target <whole quote tokens, default 85>] [--fee-bps 125] [--launch-fee 0.05] [--send]
//   node scripts/launchpad/setup.mjs init --rpc <url> --payer <key file> --admin <key file> --upgrade-authority <key file> [--send]
//   node scripts/launchpad/setup.mjs add-config --rpc <url> --admin <key file> --dbc-config <address> [--send]
//
// Every config this creates pays every platform fee to the dev wallet
// 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN (the program refuses any other).
import web3 from '@solana/web3.js';
import { vicinityConfigParams, createConfigIx } from '../../sdk/launchpad/config.mjs';
import * as C from '../../sdk/launchpad/client.mjs';
import { decodeDbcConfig, decodeMint, fetchLaunchpad } from '../../sdk/launchpad/accounts.mts';
import { feeBpsOf } from '../../sdk/launchpad/quote.mts';
import { ADDRESSES } from '../../sdk/launchpad/pda.mjs';
import { toV0Transaction, txBytes } from '../../sdk/launchpad/trade.mts';
import { connect, guardMainnet, loadKeypair, send, explorer, json } from './lib.mjs';

const { PublicKey } = web3;
const [cmd, ...rest] = process.argv.slice(2);
const a = { send: false, mainnet: false, quote: 'SOL', target: '85', feeBps: '125', launchFee: '0.05' };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  const v = () => rest[++i];
  if (k === '--rpc') a.rpc = v();
  else if (k === '--payer') a.payer = v();
  else if (k === '--admin') a.admin = v();
  else if (k === '--upgrade-authority') a.upgradeAuthority = v();
  else if (k === '--config-keypair') a.configKeypair = v();
  else if (k === '--dbc-config') a.dbcConfig = v();
  else if (k === '--quote') a.quote = v();
  else if (k === '--target') a.target = v();
  else if (k === '--fee-bps') a.feeBps = v();
  else if (k === '--launch-fee') a.launchFee = v();
  else if (k === '--send') a.send = true;
  else if (k === '--mainnet') a.mainnet = true;
  else throw new Error(`unknown option ${k}`);
}
if (!['config', 'init', 'add-config'].includes(cmd) || !a.rpc) {
  console.log('usage: setup.mjs config|init|add-config --rpc <url> ... (see the comment at the top)');
  process.exit(2);
}
const { connection, cluster } = await connect(a.rpc);
if (a.send) guardMainnet(cluster, a.mainnet, 'setup');
const out = { cluster, command: cmd, send: a.send };

async function run(payer, ixs, signers, label, cuLimit = 200_000) {
  const tx = toV0Transaction({ payer: payer.publicKey.toBase58(), instructions: ixs, cuLimit });
  out.plan = { label, bytes: txBytes(tx), signers: [payer, ...signers].map((k) => k.publicKey.toBase58()) };
  if (!a.send) return;
  const r = await send(connection, { payer, signers, ixs, cuLimit, label });
  out.signature = r.signature;
  out.explorer = explorer('tx', r.signature, cluster);
}

if (cmd === 'config') {
  const payer = loadKeypair(a.payer), cfg = loadKeypair(a.configKeypair);
  const quoteMint = a.quote === 'SOL' ? ADDRESSES.wsol : new PublicKey(a.quote).toBase58();
  const mintInfo = await connection.getAccountInfo(new PublicKey(quoteMint));
  if (!mintInfo) throw new Error(`quote mint ${quoteMint} not found on this cluster`);
  const m = decodeMint(mintInfo.data);
  if (m.mintAuthority || m.freezeAuthority) throw new Error('the quote mint must have no mint and no freeze authority (rule 7.2(2))');
  const params = vicinityConfigParams({ migrationQuoteThreshold: Number(a.target), quoteDecimals: m.decimals, tradeFeeBps: Number(a.feeBps), migratedPoolFeeBps: Number(a.feeBps), poolCreationFeeSol: Number(a.launchFee) });
  out.config = { address: cfg.publicKey.toBase58(), quoteMint, target: a.target, feeBps: a.feeBps, launchFeeSol: a.launchFee, feeClaimer: ADDRESSES.feeRecipient, leftoverReceiver: ADDRESSES.feeRecipient };
  await run(payer, [createConfigIx({ config: cfg.publicKey.toBase58(), quoteMint, payer: payer.publicKey.toBase58(), params })], [cfg], 'Meteora DBC create_config', 100_000);
  if (a.send) {
    const c = decodeDbcConfig((await connection.getAccountInfo(cfg.publicKey)).data);
    out.stored = { feeClaimer: c.feeClaimer, target: String(c.migrationQuoteThreshold), feeBps: feeBpsOf(c), swapBaseAmount: String(c.swapBaseAmount) };
  }
} else if (cmd === 'init') {
  if (await fetchLaunchpad(connection)) throw new Error('the launchpad is already initialised on this cluster');
  const payer = loadKeypair(a.payer), admin = loadKeypair(a.admin), up = loadKeypair(a.upgradeAuthority);
  await run(payer, [C.initLaunchpad({ payer: payer.publicKey.toBase58(), admin: admin.publicKey.toBase58(), upgradeAuthority: up.publicKey.toBase58() })], [admin, up], 'init_launchpad');
} else {
  const admin = loadKeypair(a.admin);
  const cfgInfo = await connection.getAccountInfo(new PublicKey(a.dbcConfig));
  if (!cfgInfo) throw new Error('DBC config not found');
  const c = decodeDbcConfig(cfgInfo.data);
  await run(admin, [C.addLaunchConfig({ admin: admin.publicKey.toBase58(), dbcConfig: a.dbcConfig, quoteMint: c.quoteMint })], [], 'add_launch_config');
}
console.log(json(out));

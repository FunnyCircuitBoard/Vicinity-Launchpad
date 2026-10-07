#!/usr/bin/env node
// Holder snapshot for one city coin's rewards round (LAUNCHPAD-DESIGN.md 12.1 to 12.3).
// Read-only: it sends nothing and needs no key.
//
// Usage, from solana/:
//   node scripts/launchpad/snapshot.mjs --rpc <url> --mint <coin mint> --sample <dir>
//        take ONE balance sample now and store it in <dir> (run this several
//        times per epoch at random, unannounced times, e.g. from a scheduler
//        that sleeps a random 2 to 10 hours between runs; never at a fixed,
//        public time)
//   node scripts/launchpad/snapshot.mjs --rpc <url> --mint <coin mint> --samples <dir> [--out <dir>]
//        [--total <raw>] [--exclude <addr,addr>] [--include <addr,addr>] [--min-payout <raw>] [--min-holders <n>]
//        plan the round: each holder counts with min(balance now, average of the samples
//        in <dir>); at least 6 samples are needed before a round is fundable. Also run
//        the cutoff itself at an unannounced time. --min-payout (raw units) is required
//        when the coin is not priced in SOL. --include adds multisig vaults (Squads)
//        that hold coins for people; program addresses are left out otherwise.
//
// It reads, at one recorded slot, every token account of the coin, the coin's
// founder from the launchpad registry, and the city's vicinity_rewards vault.
// The round total defaults to what the vault can pay now (its surplus plus the
// carry-over). It writes:
//   holders-<mint>-<slot>.json  the round file to publish; its SHA-256 is the
//                               `snapshot_hash` of fund_epoch_from_vault
//   holders-<mint>-<slot>.csv   recipient,amount for `solana-tokens
//                               distribute-spl-tokens` (push airdrops)
// and prints the Merkle root, leaf count, hash, and whether the round is worth
// funding (design 12.1: at least 20 holders receiving 0.01 SOL each).
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import web3 from '@solana/web3.js';
import { prepareRound, sampleBalances, ROUND_RULES } from '../../sdk/launchpad/snapshot.mjs';
import { toHex } from '../../sdk/merkle.mjs';

const { Connection } = web3;

function parseArgs(argv) {
  const a = { exclude: [], include: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--rpc') a.rpc = v();
    else if (k === '--mint') a.mint = v();
    else if (k === '--out') a.out = v();
    else if (k === '--total') a.total = BigInt(v());
    else if (k === '--exclude') a.exclude = v().split(',').filter(Boolean);
    else if (k === '--include') a.include = v().split(',').filter(Boolean);
    else if (k === '--sample') a.sample = v();
    else if (k === '--samples') a.samples = v();
    else if (k === '--min-payout') a.minPayout = BigInt(v());
    else if (k === '--min-holders') a.minHolders = Number(v());
    else throw new Error(`unknown option ${k}`);
  }
  if (!a.rpc || !a.mint) throw new Error('usage: snapshot.mjs --rpc <url> --mint <coin mint> (--sample <dir> | --samples <dir> [--out dir] [--total raw] [--exclude a,b] [--include a,b] [--min-payout raw] [--min-holders n])');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = new Connection(args.rpc, 'confirmed');
  const big = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
  if (args.sample) {
    const smp = await sampleBalances(connection, args.mint);
    mkdirSync(args.sample, { recursive: true });
    const file = join(args.sample, `sample-${smp.coinMint}-${smp.slot}.json`);
    writeFileSync(file, `${JSON.stringify(smp, big, 2)}\n`);
    console.log(JSON.stringify({ sampled: file, slot: smp.slot, holders: smp.balances.length }, null, 2));
    return;
  }
  const samples = args.samples
    ? readdirSync(args.samples).filter((f) => f.startsWith(`sample-${args.mint}-`) && f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(args.samples, f), 'utf8')))
    : [];
  const rules = { ...ROUND_RULES, ...(args.minHolders !== undefined ? { minHolders: args.minHolders } : {}) };
  const r = await prepareRound(connection, args.mint, { excludeOwners: args.exclude, includeOwners: args.include, total: args.total, rules, minPayout: args.minPayout, samples });
  const summary = {
    coinMint: r.mint, rewardMint: r.rewardMint, rewardDecimals: r.rewardDecimals, slot: r.slot, samples: r.samples, circulating: String(r.circulating), minBalance: String(r.minBalance),
    holdersEligible: r.eligible.length, excluded: r.excluded.length, total: String(r.total),
    leaves: r.round.leaves.length, allocated: String(r.round.allocated), dust: String(r.round.dust), fundable: r.round.fundable, reason: r.round.reason,
  };
  if (r.file) {
    const out = args.out ?? '.';
    mkdirSync(out, { recursive: true });
    const base = join(out, `holders-${r.mint}-${r.slot}`);
    writeFileSync(`${base}.json`, r.file.text);
    writeFileSync(`${base}.csv`, r.csv);
    Object.assign(summary, { merkleRoot: toHex(r.file.tree.root), snapshotHash: toHex(r.file.hash), files: [`${base}.json`, `${base}.csv`] });
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });

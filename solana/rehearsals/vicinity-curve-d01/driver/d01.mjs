// D01 rehearsal driver (VICINITY-CURVE-DESIGN.md 12.5 D01, 8.4, 8.5, 14.1). D01_TARGET=local|devnet, then a phase name.
// Throwaway keys only (solana-keys/devnet-d01), plus the documented devnet deployer of the old programs (admin of the
// old vicinity_launchpad and of the vicinity_rewards registry) for the 8.5 hand-over. No key is ever printed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as L from './lib.mjs';

const { web3, S, kp, oldKp, pk, send, devnet, loadState, saveState, record, TARGET, RPC_A, RPC_B, SOL_DIR, KEYS, TOOLS } = L;
const { PublicKey, SystemProgram, LAMPORTS_PER_SOL } = web3;
const SOLANA_BIN = '/root/.local/share/solana/install/releases/stable-44b42d45ec7e555b26ca15ad924a7432d18aaa9f/solana-release/bin';
const DEVNET_SO = `${SOL_DIR}/target/vcurve-builds/devnet/vicinity_curve.so`;
const PROGRAM_KEYPAIR = '/tmp/claude-0/-home-user-Vicinity-Launchpad/259e7af3-62d7-56de-8406-76246b95043c/scratchpad/solana-keys/vicinity_curve-keypair.json';
const OLD_DEPLOYER = 'devnet-deployer.json';
const LEGACY = 'Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7';
const LEGACY_LAUNCHPAD = 'ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw';
const LEGACY_CONFIGS = ['8pfgRZNLfftPAYF652GGPQVrjj2KgQf44AtZxfvpQ1Wa', 'GCZJQJXSaNppSVEwj88V9gHatPf28mqLhL2ttbuHT1K8'];
const REWARDS = 'Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi';
const REGISTRY = '2rKKwGGcJEDRJBhdHRPtHQpoxPmq9wPWWj3uMrcRaRg3';
const HOME = `${TOOLS}/home-${TARGET}`; // the owner's computer: the verifier's archive and its key live here
const ARCHIVE = `${HOME}/archive`;
const ix = S.curveInstructions({ cluster: 'devnet' });
const P = ix.pdas;

// The devnet demonstration config: config #0's five shares and launch fee, its curve and pool supplies, graduation
// at 1 SOL + 1 lamport (MIN_GRADUATION_LAMPORTS is 1 SOL; deriveCurve finds no integers for exactly 1 SOL at the
// default supplies) so that a coin can graduate on devnet. No fee value or share differs from config #0.
const CONFIG1 = Object.freeze({ ...S.DEFAULT_CONFIG, virtualSol: 352_951_219n, virtualTokens: 1_073_025_598_259_387n, graduationSol: 1_000_000_001n });
export const CITIES = Object.freeze({
  approved: { cityId: 990_000_001n, name: 'D01 Approved', symbol: 'D01A', configId: 1, founder: 'founder-a' },
  batchOne: { cityId: 990_000_002n, name: 'D01 Batch One', symbol: 'D01B', configId: 0, founder: 'founder-b' },
  batchTwo: { cityId: 990_000_003n, name: 'D01 Batch Two', symbol: 'D01C', configId: 1, founder: 'founder-c' },
});
const metaJson = (c) => JSON.stringify({ name: c.name, symbol: c.symbol, description: 'vicinity_curve D01 devnet rehearsal (throwaway, no value)' });
const metaHash = (c) => createHash('sha256').update(metaJson(c)).digest();

const anchorIx = (programId, disc, keys, data = Buffer.alloc(0)) => new web3.TransactionInstruction({ programId: pk(programId), keys, data: Buffer.concat([Buffer.from(disc), data]) });
const acc = (k, w = false, s = false) => ({ pubkey: pk(k), isWritable: w, isSigner: s });
const optBool = (v) => (v === null || v === undefined ? Buffer.from([0]) : Buffer.from([1, v ? 1 : 0]));

async function conn() { return devnet(RPC_A); }
async function clock(c) {
  const a = await L.account(c, 'SysvarC1ock11111111111111111111111111111111');
  const d = Buffer.from(a.data);
  return { slot: d.readBigUInt64LE(0), unixTimestamp: d.readBigInt64LE(32) };
}
const st = loadState();
const A = process.argv.slice(3);
const save = () => saveState(st);
const keyPub = (n) => kp(n).publicKey.toBase58();
function node(script, args, { env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [`${SOL_DIR}/scripts/vcurve/${script}`, ...args], { cwd: SOL_DIR, env: { ...process.env, HOME, ...env }, encoding: 'utf8', input, timeout: 600_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { code: r.status, out };
}
function toolLog(name, args, res) {
  const file = `${TOOLS}/tool-${TARGET}-${String(st.toolRuns = (st.toolRuns ?? 0) + 1).padStart(2, '0')}-${name}.txt`;
  writeFileSync(file, `$ node scripts/vcurve/${name} ${args.map((a) => (a.includes('/solana-keys/') ? '<keypair file>' : a)).join(' ')}\nexit ${res.code}\n${res.out}`);
  save();
  record({ phase: 'tool', label: name, exit: res.code, file });
  console.log(`--- ${name} exit ${res.code} (${file})\n${res.out.split('\n').slice(-25).join('\n')}`);
  return res;
}
async function coinOf(c, cityId) {
  const a = await L.account(c, P.coin(cityId));
  return S.decodeCurveCoin(a, { programId: S.CURVE_PROGRAM_ID });
}
async function waitSlot(c, target) {
  for (;;) { const s = BigInt(await c.getSlot('confirmed')); if (s >= target) return s; await L.sleep(Math.min(20_000, Math.max(1000, Number(target - s) * 400))); }
}

const phases = {
  // ------------------------------------------------------------------ funding
  async fund() {
    const c = await conn();
    if (TARGET === 'local') {
      for (const n of ['admin', 'gm1', 'gm2', 'approver', 'approver2', 'founder-a', 'founder-b', 'founder-c', 'trader-1', 'trader-2', 'keeper', 'payout-authority']) {
        const s = await c.requestAirdrop(kp(n).publicKey, 50 * LAMPORTS_PER_SOL); await c.confirmTransaction(s, 'confirmed');
      }
      const s = await c.requestAirdrop(oldKp(OLD_DEPLOYER).publicKey, 5 * LAMPORTS_PER_SOL); await c.confirmTransaction(s, 'confirmed');
      console.log('local airdrops done');
    } else {
      const from = oldKp(OLD_DEPLOYER);
      const bal = BigInt(await c.getBalance(from.publicKey));
      const keep = 30_000_000n; // enough for the hand-over's transaction fees
      const amount = bal - keep;
      if (amount <= 0n) throw new Error('nothing to move');
      await send(c, 'fund: devnet deployer -> D01 admin', [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: kp('admin').publicKey, lamports: amount })], [from], { phase: 'fund' });
    }
  },
  /** Spread SOL from the admin to the other throwaway keys (devnet). */
  async spread() {
    const c = await conn();
    const admin = kp('admin');
    const plan = JSON.parse(A[0] ?? '{}');
    const ixs = Object.entries(plan).map(([n, sol]) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: kp(n).publicKey, lamports: BigInt(Math.round(Number(sol) * 1e9)) }));
    await send(c, `spread ${Object.keys(plan).join(',')}`, ixs, [admin], { phase: 'fund' });
  },

  // ------------------------------------------------------------------ 8.5: the old program and the registry follow the admin
  async handover() {
    const c = await conn();
    const old = oldKp(OLD_DEPLOYER); const admin = kp('admin');
    const lp = Buffer.from((await L.account(c, LEGACY_LAUNCHPAD)).data);
    if (lp[168] !== 1) await send(c, 'old vicinity_launchpad: set_pause(launches = true)', [anchorIx(LEGACY, [63, 32, 154, 2, 56, 103, 79, 45], [acc(old.publicKey, false, true), acc(LEGACY_LAUNCHPAD, true)], Buffer.concat([optBool(true), optBool(null)]))], [old], { phase: 'handover' });
    for (const cfg of LEGACY_CONFIGS) {
      const d = Buffer.from((await L.account(c, cfg)).data);
      if (d[96] === 1) await send(c, `old vicinity_launchpad: set_launch_config_enabled(false) ${cfg}`, [anchorIx(LEGACY, [123, 210, 135, 55, 41, 13, 19, 17], [acc(old.publicKey, false, true), acc(LEGACY_LAUNCHPAD), acc(cfg, true)], Buffer.from([0]))], [old], { phase: 'handover' });
    }
    const lp2 = Buffer.from((await L.account(c, LEGACY_LAUNCHPAD)).data);
    if (new PublicKey(lp2.subarray(8, 40)).toBase58() !== admin.publicKey.toBase58()) {
      await send(c, 'old vicinity_launchpad: propose_admin(D01 admin)', [anchorIx(LEGACY, [121, 214, 199, 212, 87, 39, 117, 234], [acc(old.publicKey, false, true), acc(LEGACY_LAUNCHPAD, true)], admin.publicKey.toBuffer())], [old], { phase: 'handover' });
      await send(c, 'old vicinity_launchpad: accept_admin (D01 admin)', [anchorIx(LEGACY, [112, 42, 45, 90, 116, 181, 13, 170], [acc(admin.publicKey, false, true), acc(LEGACY_LAUNCHPAD, true)])], [admin], { phase: 'handover' });
    }
    const rg = Buffer.from((await L.account(c, REGISTRY)).data);
    if (new PublicKey(rg.subarray(8, 40)).toBase58() !== admin.publicKey.toBase58()) {
      await send(c, 'vicinity_rewards registry: propose_admin(D01 admin)', [anchorIx(REWARDS, [121, 214, 199, 212, 87, 39, 117, 234], [acc(old.publicKey, false, true), acc(REGISTRY, true)], admin.publicKey.toBuffer())], [old], { phase: 'handover' });
      await send(c, 'vicinity_rewards registry: accept_admin (D01 admin)', [anchorIx(REWARDS, [112, 42, 45, 90, 116, 181, 13, 170], [acc(admin.publicKey, false, true), acc(REGISTRY, true)])], [admin], { phase: 'handover' });
    }
  },

  // ------------------------------------------------------------------ the guardian: a controlled 1-of-2 Squads v4 multisig, no time lock
  async guardian() {
    const c = await conn();
    const ms = L.squads();
    const createKey = kp('squads-create'); const admin = kp('admin');
    const [multisig] = ms.getMultisigPda({ createKey: createKey.publicKey });
    const [vault] = ms.getVaultPda({ multisigPda: multisig, index: 0 });
    const [programConfigPda] = ms.getProgramConfigPda({});
    const cfg = await ms.accounts.ProgramConfig.fromAccountAddress(c, programConfigPda);
    if (!(await c.getAccountInfo(multisig))) {
      const members = ['gm1', 'gm2'].map((n) => ({ key: kp(n).publicKey, permissions: ms.types.Permissions.all() }));
      const createIx = ms.instructions.multisigCreateV2({ treasury: cfg.treasury, creator: admin.publicKey, multisigPda: multisig, configAuthority: admin.publicKey, threshold: 1, timeLock: 0, createKey: createKey.publicKey, rentCollector: null, members });
      await send(c, 'Squads v4 multisig_create_v2: guardian multisig (controlled by the admin, 1 of 2, no time lock)', [createIx], [admin, createKey], { phase: 'guardian', note: `creation fee ${cfg.multisigCreationFee}` });
    }
    st.guardianMultisig = multisig.toBase58(); st.guardian = vault.toBase58(); save();
    console.log(JSON.stringify({ multisig: st.guardianMultisig, guardianVault0: st.guardian }));
  },

  // ------------------------------------------------------------------ deploy (the devnet build, the throwaway program id)
  async deploy() {
    const so = readFileSync(DEVNET_SO);
    st.devnetSoSha256 = L.sha256hex(so); st.devnetSoBytes = so.length; save();
    const args = ['program', 'deploy', DEVNET_SO, '--program-id', PROGRAM_KEYPAIR, '--upgrade-authority', `${KEYS}/admin.json`, '--keypair', `${KEYS}/admin.json`,
      '-u', RPC_A, '--commitment', 'confirmed', '--max-sign-attempts', '50', '--output', 'json'];
    const t0 = Date.now();
    const r = spawnSync(`${SOLANA_BIN}/solana`, args, { encoding: 'utf8', timeout: 3_600_000 });
    const out = `${r.stdout}${r.stderr}`;
    writeFileSync(`${TOOLS}/deploy-${TARGET}.txt`, out.replace(/\[[0-9, ]{100,}\]/g, '[..]'));
    if (r.status !== 0) throw new Error(`deploy failed: ${out.slice(-2000)}`);
    const m = /"signature"\s*:\s*"(\w+)"/.exec(out);
    st.deploySignature = m?.[1]; st.deploySecs = Math.round((Date.now() - t0) / 1000); save();
    record({ phase: 'deploy', label: 'solana program deploy (devnet build)', sig: st.deploySignature, secs: st.deploySecs });
    console.log('deployed', st.deploySignature, `${st.deploySecs}s`);
  },
  async verifyDeploy() {
    const out = `${TOOLS}/dump-${TARGET}.so`;
    execFileSync(`${SOLANA_BIN}/solana`, ['program', 'dump', S.CURVE_PROGRAM_ID, out, '-u', RPC_A], { encoding: 'utf8' });
    const dumped = readFileSync(out); const local = readFileSync(DEVNET_SO);
    const same = dumped.subarray(0, local.length).equals(local) && dumped.subarray(local.length).every((b) => b === 0);
    const show = execFileSync(`${SOLANA_BIN}/solana`, ['program', 'show', S.CURVE_PROGRAM_ID, '-u', RPC_A, '--output', 'json'], { encoding: 'utf8' });
    st.programShow = JSON.parse(show); st.dumpMatches = same; st.dumpSha256 = L.sha256hex(dumped.subarray(0, local.length)); save();
    console.log(JSON.stringify({ same, sha: st.dumpSha256, show: st.programShow }));
  },

  // ------------------------------------------------------------------ init, configs, payout keys, the batch path
  async init() {
    const c = await conn(); const admin = kp('admin');
    if (!(await c.getAccountInfo(pk(P.launchpad())))) {
      await send(c, 'init_launchpad(guardian = vault 0 of the guardian multisig)', [ix.initLaunchpad({ payer: admin.publicKey, admin: admin.publicKey, upgradeAuthority: admin.publicKey, guardian: st.guardian })], [admin], { phase: 'init' });
    }
    let lp = S.decodeLaunchpad(await L.account(c, P.launchpad()));
    if (lp.nextConfigId === 0 || Number(lp.nextConfigId) === 0) {
      await send(c, 'add_launch_config #0 (5.9 defaults: 85 SOL)', [ix.addLaunchConfig({ admin: admin.publicKey, configId: 0, params: S.DEFAULT_CONFIG })], [admin], { phase: 'init' });
      lp = S.decodeLaunchpad(await L.account(c, P.launchpad()));
    }
    if (Number(lp.nextConfigId) === 1) {
      if (S.configRule(CONFIG1) !== null) throw new Error(`config #1 fails ${S.configRule(CONFIG1)}`);
      await send(c, 'add_launch_config #1 (config #0 shares and fee; graduation 1.000000001 SOL)', [ix.addLaunchConfig({ admin: admin.publicKey, configId: 1, params: CONFIG1 })], [admin], { phase: 'init' });
    }
    lp = S.decodeLaunchpad(await L.account(c, P.launchpad()));
    if (String(lp.payoutAuthority) !== keyPub('payout-authority')) {
      await send(c, 'set_payout_config(payout key, payout wallet)', [ix.setPayoutConfig({ admin: admin.publicKey, payoutAuthority: kp('payout-authority').publicKey, payoutDestination: kp('payout-wallet').publicKey })], [admin], { phase: 'init' });
    }
    if (!(await c.getAccountInfo(pk(P.launchBatch())))) {
      await send(c, 'init_launch_batch', [ix.initLaunchBatch({ admin: admin.publicKey })], [admin], { phase: 'init' });
    }
  },
  async preflightApprover() {
    const args = ['--rpc', RPC_A, '--vault', keyPub('admin'), '--guardian-multisig', st.guardianMultisig, '--cluster', 'devnet', '--proposed-launch-approver', keyPub('approver')];
    toolLog('preflight.mjs', args, node('preflight.mjs', args));
  },
  async setApprover() {
    const c = await conn(); const admin = kp('admin');
    const lp = S.decodeLaunchpad(await L.account(c, P.launchpad()));
    if (String(lp.launchApprover) !== keyPub('approver')) {
      await send(c, 'set_launch_approver(approver)', [ix.setLaunchApprover({ admin: admin.publicKey, approver: kp('approver').publicKey })], [admin], { phase: 'init' });
    }
  },
  async preflight() {
    const args = ['--rpc', RPC_A, '--vault', keyPub('admin'), '--guardian-multisig', st.guardianMultisig, '--cluster', 'devnet'];
    toolLog('preflight.mjs', args, node('preflight.mjs', args));
  },

  // ------------------------------------------------------------------ the launch batch: the list, verify, sign, confirm, check
  async batchList() {
    const c = await conn();
    const lp = S.decodeLaunchpad(await L.account(c, P.launchpad()));
    const lb = S.decodeLaunchBatch(await L.account(c, P.launchBatch()));
    const seq = BigInt(lb.latest?.seq ?? lb.latestSeq ?? 0n) + 1n;
    const entries = [CITIES.batchOne, CITIES.batchTwo].map((x) => ({ cityId: x.cityId, founder: keyPub(x.founder), configId: x.configId, metaHash: metaHash(x), name: x.name, symbol: x.symbol }));
    // three more entries nobody will launch (founders are hashes, not keys anyone holds), so that proofs have 2 or 3 hashes
    for (let i = 1; i <= 3; i++) {
      const f = { cityId: 990_000_010n + BigInt(i), name: `D01 Filler ${i}`, symbol: `D01F${i}`, configId: 0 };
      entries.push({ cityId: f.cityId, founder: new PublicKey(createHash('sha256').update(`D01 filler founder ${i}`).digest()).toBase58(), configId: 0, metaHash: metaHash(f), name: f.name, symbol: f.symbol });
    }
    const batch = S.buildLaunchBatch(entries, { batchSeq: seq, launchpad: lp });
    const file = S.launchBatchFile(batch);
    mkdirSync(`${TOOLS}/lists-${TARGET}`, { recursive: true });
    const path = `${TOOLS}/lists-${TARGET}/batch-${seq}.json`;
    writeFileSync(path, typeof file === 'string' ? file : JSON.stringify(file, null, 1));
    st.batchFile = path; st.batchSeq = String(seq); save();
    console.log('list file', path, 'seq', String(seq));
  },
  async batchList2() {
    // after the clear and the rotation: a new list of three entries nobody will launch (the next day's batch), seq latest + 1
    const c = await conn();
    const lp = S.decodeLaunchpad(await L.account(c, P.launchpad()));
    const lb = S.decodeLaunchBatch(await L.account(c, P.launchBatch()));
    const seq = BigInt(lb.latest?.seq ?? lb.latestSeq ?? 0n) + 1n;
    const entries = [];
    for (let i = 1; i <= 3; i++) {
      const f = { cityId: 990_000_020n + BigInt(i), name: `D01 Next ${i}`, symbol: `D01N${i}`, configId: 0 };
      entries.push({ cityId: f.cityId, founder: new PublicKey(createHash('sha256').update(`D01 next founder ${i}`).digest()).toBase58(), configId: 0, metaHash: metaHash(f), name: f.name, symbol: f.symbol });
    }
    const batch = S.buildLaunchBatch(entries, { batchSeq: seq, launchpad: lp });
    const file = S.launchBatchFile(batch);
    const path = `${TOOLS}/lists-${TARGET}/batch-${seq}.json`;
    writeFileSync(path, typeof file === 'string' ? file : JSON.stringify(file, null, 1));
    st.batchFile1 = st.batchFile1 ?? st.batchFile; st.batchFile = path; st.batchSeq = String(seq); save();
    console.log('list file', path, 'seq', String(seq));
  },
  async batchVerifyPublish() {
    const c = await conn();
    const who = process.env.D01_APPROVER ?? 'approver';
    const args = ['verify', st.batchFile, '--rpc', RPC_A, '--rpc', RPC_B, '--approver', keyPub(who), '--archive', ARCHIVE, '--cluster', 'devnet'];
    const res = toolLog('batch.mjs', args, node('batch.mjs', args));
    if (res.code !== 0) throw new Error('verify refused');
    const lines = res.out.split('\n');
    const i = lines.findIndex((l) => l.startsWith('unsigned '));
    const b64 = lines[i + 1].trim();
    const hash = /message hash (\w+)/.exec(res.out)[1];
    const tx = web3.Transaction.from(Buffer.from(b64, 'base64'));
    const ours = createHash('sha256').update(tx.serializeMessage()).digest();
    st.publishMessageHash = hash; save();
    tx.partialSign(kp(who));
    const raw = tx.serialize();
    const sig = await c.sendRawTransaction(raw, { maxRetries: 5 });
    await c.confirmTransaction(sig, 'confirmed');
    const got = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    record({ phase: who === 'approver' ? 'batch' : 'clear', label: `publish_launch_batch (the verifier's transaction, signed by the ${who === 'approver' ? 'approver' : 'new approver'})`, sig, slot: got.slot, ok: !got.meta.err, cu: got.meta.computeUnitsConsumed, fee: got.meta.fee, bytes: raw.length, perProgram: L.topLevelCu(got.meta.logMessages), events: S.decodeTransactionEvents(got).map((e) => e.name), note: `message hash ${hash}` });
    st.publishSig = sig; save();
    const lb = S.decodeLaunchBatch(await L.account(c, P.launchBatch()));
    st.batchRecord = JSON.parse(JSON.stringify(lb, (k, v) => (typeof v === 'bigint' ? String(v) : v))); save();
    console.log('published', sig, 'hex of our message sha256', ours.toString('hex').slice(0, 16));
  },
  async batchConfirm() {
    const root = JSON.parse(readFileSync(st.batchFile, 'utf8')).root;
    const args = ['confirm', st.batchSeq, root, '--rpc', RPC_A, '--rpc', RPC_B, '--archive', ARCHIVE, '--cluster', 'devnet'];
    toolLog('batch.mjs', args, node('batch.mjs', args));
  },
  async batchCheck() {
    const which = A[0] ?? 'signed';
    const dir = `${ARCHIVE}/${S.CURVE_PROGRAM_ID}/${which}`;
    const f = existsSync(dir) ? execFileSync('ls', [dir], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).pop() : null;
    const target = f ? `${dir}/${f}` : st.batchFile;
    const args = ['check', target, '--rpc', RPC_A, '--rpc', RPC_B, '--cluster', 'devnet'];
    toolLog('batch.mjs', args, node('batch.mjs', args));
  },

  // ------------------------------------------------------------------ the per-city path: approve, launch with the founder's first buy
  async approve() {
    const c = await conn(); const admin = kp('admin'); const x = CITIES.approved;
    if (await c.getAccountInfo(pk(P.coin(x.cityId)))) return console.log('already launched');
    const now = (await clock(c)).unixTimestamp;
    await send(c, `approve_launch(${x.cityId}, ${x.symbol}, config #${x.configId})`, [ix.approveLaunch({ admin: admin.publicKey, cityId: x.cityId, founder: kp(x.founder).publicKey, configId: x.configId, name: x.name, symbol: x.symbol, metaHash: metaHash(x), expiresAt: now + 7n * 86_400n })], [admin], { phase: 'per-city' });
  },
  async approveBatchCity() {
    // X75 on chain: a per-city approval for a city that is also in the batch takes precedence (ApprovalPending at launch_from_batch)
    const c = await conn(); const admin = kp('admin'); const x = CITIES.batchTwo;
    const now = (await clock(c)).unixTimestamp;
    await send(c, `approve_launch(${x.cityId}, ${x.symbol}) for a city that is also in batch 1`, [ix.approveLaunch({ admin: admin.publicKey, cityId: x.cityId, founder: kp(x.founder).publicKey, configId: x.configId, name: x.name, symbol: x.symbol, metaHash: metaHash(x), expiresAt: now + 7n * 86_400n })], [admin], { phase: 'per-city' });
  },
  async revokeBatchCity() {
    const c = await conn(); const admin = kp('admin'); const x = CITIES.batchTwo;
    await send(c, `revoke_approval(${x.cityId}) by the admin`, [ix.revokeApproval({ by: admin.publicKey, cityId: x.cityId, rentPayer: admin.publicKey })], [admin], { phase: 'per-city' });
  },
  async launch() {
    const c = await conn(); const x = CITIES.approved; const f = kp(x.founder);
    const ap = S.decodeApproval(await L.account(c, P.approval(x.cityId)));
    const cfg = S.decodeLaunchConfig(await L.account(c, P.config(x.configId)));
    const terms = S.termsFromParams(S.configParamsOf(cfg));
    const solIn = 50_000_000n; // the founder's first buy, 0.05 SOL
    const q = S.quoteBuy(terms, S.stateAtLaunch(0n), solIn);
    const { mint } = P.coinAccounts(x.cityId);
    await send(c, `launch(${x.cityId}) + founder token account + first buy 0.05 SOL`, [
      ix.launch({ founder: f.publicKey, cityId: x.cityId, configId: x.configId, symbol: x.symbol, rentPayer: ap.rentPayer }),
      S.createAssociatedTokenAccountIdempotent({ payer: f.publicKey, owner: f.publicKey, mint }),
      ix.buy({ user: f.publicKey, cityId: x.cityId, solIn, minTokensOut: S.withSlippage(q.tokensOut, 100) }),
    ], [f], { phase: 'per-city', cuLimit: 400_000 });
  },

  // ------------------------------------------------------------------ trading on the curve, outflows, rewards link
  async trade() {
    const c = await conn(); const x = CITIES[process.env.D01_CITY ?? 'approved']; const op = A[0]; const who = A[1]; const amt = BigInt(A[2] ?? '0');
    const u = kp(who); const coin = await coinOf(c, x.cityId);
    if (op === 'buy') {
      const leg = S.buyLeg({ solIn: amt, coinAccount: coin, slippageBps: S.buySlippagePolicy(coin, amt).defaultSlippageBps });
      return send(c, `buy ${who} ${Number(leg.solIn) / 1e9} SOL (${coin.phase === 0 ? 'curve' : 'pool'})`, [S.createAssociatedTokenAccountIdempotent({ payer: u.publicKey, owner: u.publicKey, mint: coin.mint }), ix.buy({ user: u.publicKey, cityId: x.cityId, solIn: leg.solIn, minTokensOut: leg.minTokensOut })], [u], { phase: 'trade', cuLimit: 120_000 });
    }
    if (op === 'sell') {
      const ata = S.associatedTokenAddress(u.publicKey, coin.mint);
      const bal = BigInt((await c.getTokenAccountBalance(pk(ata))).value.amount);
      const tokensIn = amt === 0n ? bal : (bal * amt) / 100n; // amt = percent
      const leg = S.sellLeg({ tokensIn, coinAccount: coin, slippageBps: S.sellSlippagePolicy(coin, tokensIn).defaultSlippageBps });
      return send(c, `sell ${who} ${tokensIn} raw (${coin.phase === 0 ? 'curve' : 'pool'})`, [ix.sell({ user: u.publicKey, cityId: x.cityId, tokensIn, minSolOut: leg.minSolOut })], [u], { phase: 'trade', cuLimit: 80_000 });
    }
    throw new Error('op buy|sell');
  },
  async buyback() {
    const c = await conn(); const cityId = BigInt(A[0] ?? CITIES.approved.cityId); const k = kp('keeper');
    const coin = await coinOf(c, cityId);
    await waitSlot(c, BigInt(coin.lastBuybackSlot) + 150n);
    const before = await coinOf(c, cityId);
    const e = await send(c, `buyback_burn ${cityId} (${before.phase === 0 ? 'curve' : 'pool'}; pending ${before.buybackPending})`, [ix.buybackBurn({ cityId })], [k], { phase: 'buyback', cuLimit: 80_000 });
    const after = await coinOf(c, cityId);
    record({ phase: 'buyback', label: 'buyback effect', sig: e.sig, spent: String(after.buybackSpent - before.buybackSpent), burned: String(after.tokensBurned - before.tokensBurned), pendingBefore: String(before.buybackPending), pendingAfter: String(after.buybackPending) });
  },
  async outflows() {
    const c = await conn(); const cityId = BigInt(A[0] ?? CITIES.approved.cityId); const k = kp('keeper');
    const x = Object.values(CITIES).find((y) => y.cityId === cityId);
    await send(c, `withdraw_platform_fees ${cityId}`, [ix.withdrawPlatformFees({ cityId })], [k], { phase: 'outflows', cuLimit: 60_000 });
    await send(c, `claim_founder_fees ${cityId}`, [ix.claimFounderFees({ founder: kp(x.founder).publicKey, cityId })], [kp(x.founder)], { phase: 'outflows', cuLimit: 60_000 });
  },
  async rewardsLink() {
    const c = await conn(); const admin = kp('admin'); const cityId = BigInt(A[0] ?? CITIES.approved.cityId);
    const x = Object.values(CITIES).find((y) => y.cityId === cityId);
    const coin = await coinOf(c, cityId);
    const { config } = P.rewardsAccounts(coin.mint);
    if (!(await c.getAccountInfo(pk(config)))) {
      await send(c, `vicinity_rewards init_city (Holders, 0, WSOL) for ${x.symbol}`, [S.initCityInstruction({ payer: admin.publicKey, registryAdmin: admin.publicKey, authority: admin.publicKey, founder: kp(x.founder).publicKey, mint: coin.mint, cluster: 'devnet' })], [admin], { phase: 'rewards' });
    }
  },
  async forward() {
    const c = await conn(); const cityId = BigInt(A[0] ?? CITIES.approved.cityId); const k = kp('keeper');
    await send(c, `forward_holders_fees ${cityId} + SyncNative`, ix.forwardHoldersFeesWithSync({ cityId }), [k], { phase: 'rewards', cuLimit: 80_000 });
  },
  async payout() {
    const c = await conn(); const x = CITIES.approved; const f = kp(x.founder); const pa = kp('payout-authority');
    const coin = P.coin(x.cityId);
    if (!(await c.getAccountInfo(pk(P.payoutOptIn(coin))))) {
      await send(c, 'opt_in_payout (founder A, the payout wallet)', [ix.optInPayout({ founder: f.publicKey, cityId: x.cityId, expectedDestination: kp('payout-wallet').publicKey, refHash: createHash('sha256').update('D01 payout reference').digest() })], [f], { phase: 'payout' });
    }
    const w = kp('payout-wallet').publicKey;
    if ((await c.getBalance(w)) === 0) await send(c, 'fund the payout wallet with its rent-exempt minimum (14.3)', [SystemProgram.transfer({ fromPubkey: pa.publicKey, toPubkey: w, lamports: 1_000_000 })], [pa], { phase: 'payout' });
    await send(c, 'payout_founder_fees (payout key -> payout wallet)', [ix.payoutFounderFees({ payoutAuthority: pa.publicKey, cityId: x.cityId, destination: w })], [pa], { phase: 'payout', cuLimit: 60_000 });
  },
  async payoutAgain() {
    const c = await conn(); const x = CITIES.approved; const pa = kp('payout-authority');
    await send(c, 'payout_founder_fees again inside the 24 h cooldown (refused)', [ix.payoutFounderFees({ payoutAuthority: pa.publicKey, cityId: x.cityId, destination: kp('payout-wallet').publicKey })], [pa], { phase: 'payout', cuLimit: 60_000, expectError: 'PayoutTooSoon' });
  },
  async graduate() {
    const c = await conn(); const x = CITIES.approved; const u = kp('trader-2');
    const coin = await coinOf(c, x.cityId);
    const want = BigInt(coin.graduationSol) * 2n; // more than the rest of the curve: the buy completes it and is capped (partial fill)
    const leg = S.buyLeg({ solIn: want, coinAccount: coin, slippageBps: S.buySlippagePolicy(coin, want).defaultSlippageBps });
    record({ phase: 'graduate', label: 'graduating buy quote', solInOffered: String(want), solInCapped: String(leg.solIn), minTokensOut: String(leg.minTokensOut) });
    await send(c, `buy that graduates (trader-2 offers ${Number(leg.solIn) / 1e9} SOL)`, [S.createAssociatedTokenAccountIdempotent({ payer: u.publicKey, owner: u.publicKey, mint: coin.mint }), ix.buy({ user: u.publicKey, cityId: x.cityId, solIn: leg.solIn, minTokensOut: leg.minTokensOut })], [u], { phase: 'graduate', cuLimit: 150_000 });
    const after = await coinOf(c, x.cityId);
    st.graduated = { phase: after.phase, poolSol: String(after.poolSol), poolTokens: String(after.poolTokens), liquidityPending: String(after.liquidityPending), tokensSold: String(after.tokensSold), curveSol: String(after.curveSol) }; save();
    console.log(JSON.stringify(st.graduated));
  },

  // ------------------------------------------------------------------ the guardian stop and its recovery
  async stop() {
    const flags = A; // e.g. --halt-buys --pause-launches, or --clear
    const member = process.env.D01_MEMBER ?? 'gm1';
    const args = ['--rpc', RPC_A, '--rpc', RPC_B, '--multisig', st.guardianMultisig, '--keypair', `${KEYS}/${member}.json`, ...flags, '--cluster', 'devnet', '--priority-fee', '1000', '--rounds', '3'];
    toolLog('guardian-stop.mjs', args, node('guardian-stop.mjs', args));
  },
  async haltChecks() {
    const c = await conn(); const x = CITIES.approved;
    const coin = await coinOf(c, x.cityId); const t = kp('trader-1');
    const lpNow = S.decodeLaunchpad(await L.account(c, P.launchpad()));
    record({ phase: 'halt', label: 'Launchpad flags after the guardian stop', launchesPaused: lpNow.launchesPaused, buysHalted: lpNow.buysHalted, buybacksHalted: lpNow.buybacksHalted, payoutsPaused: lpNow.payoutsPaused });
    await send(c, 'buy while buys are halted (refused)', [ix.buy({ user: t.publicKey, cityId: x.cityId, solIn: 1_000_000n, minTokensOut: 1n })], [t], { phase: 'halt', cuLimit: 80_000, expectError: 'BuysHalted' });
    const ata = S.associatedTokenAddress(t.publicKey, coin.mint);
    const bal = BigInt((await c.getTokenAccountBalance(pk(ata))).value.amount);
    const tokensIn = bal / 10n;
    const leg = S.sellLeg({ tokensIn, coinAccount: coin, slippageBps: S.sellSlippagePolicy(coin, tokensIn).defaultSlippageBps });
    await send(c, 'sell while buys are halted (works)', [ix.sell({ user: t.publicKey, cityId: x.cityId, tokensIn, minSolOut: leg.minSolOut })], [t], { phase: 'halt', cuLimit: 80_000 });
    await send(c, 'claim_founder_fees while halted (works)', [ix.claimFounderFees({ founder: kp(x.founder).publicKey, cityId: x.cityId })], [kp(x.founder)], { phase: 'halt', cuLimit: 60_000 });
    await send(c, 'withdraw_platform_fees while halted (works)', [ix.withdrawPlatformFees({ cityId: x.cityId })], [kp('keeper')], { phase: 'halt', cuLimit: 60_000 });
  },
  async recover() {
    const c = await conn(); const admin = kp('admin');
    const lp = S.decodeLaunchpad(await L.account(c, P.launchpad()));
    const flags = { launches: lp.launchesPaused ? false : null, buybacks: lp.buybacksHalted ? false : null, buys: lp.buysHalted ? false : null };
    await send(c, `admin set_pause(${JSON.stringify(flags)}): the recovery`, [ix.setPause({ authority: admin.publicKey, ...flags })], [admin], { phase: 'recover' });
  },
  async guardianTriesToResume() {
    // a guardian member creates, proposes, approves and executes a vault transaction whose inner call resumes buys:
    // the program refuses the guardian's set_pause(buys = false) (Unauthorized, 4.4; X43b), so the execute fails
    const c = await conn(); const m = kp('gm2');
    const G = await import(`${SOL_DIR}/scripts/vcurve/guardian-stop.mjs`);
    const ms = L.squads();
    const msAcc = await ms.accounts.Multisig.fromAccountAddress(c, pk(st.guardianMultisig));
    const index = BigInt(String(msAcc.transactionIndex)) + 1n;
    const inner = [ix.setPause({ authority: st.guardian, buys: false })];
    const call = G.squadsVaultCall({ multisig: st.guardianMultisig, member: m.publicKey.toBase58(), transactionIndex: index, instructions: inner });
    await send(c, 'guardian vault: set_pause(buys = false) through Squads (refused: the guardian can only stop)', [call.create, call.propose, call.approve, call.execute], [m], { phase: 'halt', cuLimit: 200_000, expectError: 'Unauthorized' });
  },
  async buybackHalt() {
    const c = await conn(); const admin = kp('admin'); const x = CITIES.approved;
    await send(c, 'admin set_pause(buybacks = true) alone (refused: buybacks halt only with buys, LL-1)', [ix.setPause({ authority: admin.publicKey, buybacks: true })], [admin], { phase: 'halt', expectError: 'BuybackHaltWithoutBuyHalt' });
    await send(c, 'admin set_pause(buys = true, buybacks = true)', [ix.setPause({ authority: admin.publicKey, buys: true, buybacks: true })], [admin], { phase: 'halt' });
    const coin = await coinOf(c, x.cityId);
    await waitSlot(c, BigInt(coin.lastBuybackSlot) + 150n);
    await send(c, 'buyback_burn while buybacks are halted (refused)', [ix.buybackBurn({ cityId: x.cityId })], [kp('keeper')], { phase: 'halt', cuLimit: 80_000, expectError: 'BuybacksHalted' });
    await send(c, 'admin set_pause(buys = false) while buybacks stay halted (refused: buys never reopen before buybacks)', [ix.setPause({ authority: admin.publicKey, buys: false })], [admin], { phase: 'halt', expectError: 'BuybackHaltWithoutBuyHalt' });
    await send(c, 'admin set_pause(buybacks = false): buybacks first', [ix.setPause({ authority: admin.publicKey, buybacks: false })], [admin], { phase: 'recover' });
    await send(c, 'buyback_burn with buys still halted (the keeper drains the backlog)', [ix.buybackBurn({ cityId: x.cityId })], [kp('keeper')], { phase: 'recover', cuLimit: 80_000 });
    await send(c, 'admin set_pause(buys = false): then buys', [ix.setPause({ authority: admin.publicKey, buys: false })], [admin], { phase: 'recover' });
  },

  // ------------------------------------------------------------------ after the review window: launches from the batch, the clear, the rotation
  async batchLaunch() {
    const c = await conn(); const which = A[0] ?? 'batchOne'; const x = CITIES[which]; const f = kp(x.founder);
    const file = S.parseLaunchBatchFile(readFileSync(st.batchFile1 ?? st.batchFile, 'utf8'));
    const args = S.launchBatchArgs(file, x.cityId);
    const cfg = S.decodeLaunchConfig(await L.account(c, P.config(x.configId)));
    const terms = S.termsFromParams(S.configParamsOf(cfg));
    const solIn = 20_000_000n;
    const q = S.quoteBuy(terms, S.stateAtLaunch(0n), solIn);
    const { mint } = P.coinAccounts(x.cityId);
    const expectError = A[1];
    await send(c, `launch_from_batch(${x.cityId}, batch ${args.batchSeq}, proof ${args.proof.length}) + token account + first buy 0.02 SOL${expectError ? ' (refused)' : ''}`, [
      ix.launchFromBatch({ founder: f.publicKey, ...args }),
      S.createAssociatedTokenAccountIdempotent({ payer: f.publicKey, owner: f.publicKey, mint }),
      ix.buy({ user: f.publicKey, cityId: x.cityId, solIn, minTokensOut: S.withSlippage(q.tokensOut, 100) }),
    ], [f], { phase: 'batch-launch', cuLimit: 400_000, expectError, lookupTables: st.alt ? [(await c.getAddressLookupTable(pk(st.alt))).value] : [], note: st.alt ? 'with the lookup table' : undefined });
  },
  async publishAfterHalt() {
    const c = await conn(); const a = kp('approver'); const now = (await clock(c)).unixTimestamp;
    const lb = S.decodeLaunchBatch(await L.account(c, P.launchBatch()));
    const vf = now + 43_200n + 600n;
    await send(c, 'publish_launch_batch by the approver while the batch path is halted (refused)', [ix.publishLaunchBatch({ approver: a.publicKey, seq: BigInt(lb.latest?.seq ?? 0n) + 1n, root: Buffer.alloc(32, 7), leafCount: 1, validFrom: vf, validUntil: vf + 3_600n })], [a], { phase: 'clear', expectError: 'BatchesHalted' });
  },
  async rotate() {
    const c = await conn(); const admin = kp('admin');
    await send(c, 'set_launch_approver(approver2): lifts the halt, clears both records', [ix.setLaunchApprover({ admin: admin.publicKey, approver: kp('approver2').publicKey })], [admin], { phase: 'recover' });
  },

  // ------------------------------------------------------------------ the website's lookup table (11.3): the static accounts of a launch with the first buy
  async alt() {
    const c = await conn(); const admin = kp('admin');
    if (!st.alt) {
      const slot = (await c.getSlot('confirmed')) - 1;
      const [create, table] = web3.AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot });
      await send(c, 'create the lookup table (11.3)', [create], [admin], { phase: 'alt' });
      st.alt = table.toBase58(); save();
    }
    const A = S.ADDRESSES;
    const addrs = [A.system, A.token, A.associatedToken, A.metaplex, A.computeBudget, A.rentSysvar, P.eventAuthority(), S.CURVE_PROGRAM_ID, A.feeRecipient,
      P.launchpad(), P.launchBatch(), P.cluster.legacyLaunchpad, P.cluster.rewardsRegistry, P.config(0), P.config(1)].map((x) => pk(x));
    await send(c, `extend the lookup table with ${addrs.length} static addresses`, [web3.AddressLookupTableProgram.extendLookupTable({ lookupTable: pk(st.alt), authority: admin.publicKey, payer: admin.publicKey, addresses: addrs })], [admin], { phase: 'alt' });
  },

  // ------------------------------------------------------------------ read-back
  async show() {
    const c = await conn();
    const lp = S.decodeLaunchpad(await L.account(c, P.launchpad()));
    const lb = S.decodeLaunchBatch(await L.account(c, P.launchBatch()));
    const out = { launchpad: P.launchpad(), lp, launchBatch: P.launchBatch(), lb, coins: {} };
    for (const [k, x] of Object.entries(CITIES)) {
      const a = await c.getAccountInfo(pk(P.coin(x.cityId)));
      if (a) { const coin = S.decodeCurveCoin(a, { programId: S.CURVE_PROGRAM_ID }); out.coins[k] = { address: P.coin(x.cityId), lamports: a.lamports, ...coin, liabilities: S.liabilities(S.coinState(coin)) }; }
    }
    console.log(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v), 1));
  },
};

const name = process.argv[2];
if (!phases[name]) { console.error(`phases: ${Object.keys(phases).join(' ')}`); process.exit(2); }
console.log(`== D01 ${TARGET}: ${name}`);
await phases[name]();

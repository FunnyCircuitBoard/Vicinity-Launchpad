#!/usr/bin/env python3
"""Mutation tests of the batch launch approval's rules (VICINITY-CURVE-NOTES.md entry 77).

Each mutant removes or weakens one rule of 4.23 to 4.27, 8.3 or 8.6 in the program source (an exact,
unique string replacement), is built with cargo-build-sbf into its own out dir (the source is restored
at once, also on failure), and the named litesvm tests run against it through VCURVE_SO (or
VCURVE_HALT_ALL_SO). A mutant is killed when a test fails. With MUTANT_CHECKS_OFF=1 the tests run
without the per-transaction checker (VCURVE_INVARIANTS=off), so only explicit assertions can kill.
Never run it while another build or test of the program reads the source: it patches it in place.

Usage (from solana/, with cargo-build-sbf on PATH):
  python3 scripts/vcurve/batch-mutants.py . <out dir> [mutant name ...]
"""
import json
import os
import subprocess
import sys
import time

SOL = sys.argv[1]
OUT = sys.argv[2]
ONLY = set(sys.argv[3:])
P = 'programs/vicinity-curve/src/'
LFB = P + 'instructions/launch_from_batch.rs'
PUB = P + 'instructions/publish_launch_batch.rs'
SLA = P + 'instructions/set_launch_approver.rs'
CLR = P + 'instructions/clear_launch_batch.rs'
BATCH = P + 'batch.rs'
HELP = P + 'helpers.rs'
T30 = 'tests-curve/30-batch.test.mjs'
T11 = 'tests-curve/11-halts.test.mjs'

MUTANTS = [
    # publish_launch_batch (4.25)
    ('publish-any-signer', [(PUB, 'set != Pubkey::default() && approver == set,', 'true || (set != Pubkey::default() && approver == set),')], [T30]),
    ('publish-while-halted', [(PUB, 'require!(!lb.halted, CurveError::BatchesHalted);', '')], [T30]),
    ('publish-seq-only-increasing', [(PUB, 'lb.latest.seq.checked_add(1) == Some(seq),', 'seq > lb.latest.seq,')], [T30]),
    ('publish-zero-root', [(PUB, 'require!(root != [0u8; 32], CurveError::BadBatchRoot);', '')], [T30]),
    ('publish-leaf-count-unbounded', [(PUB, '(1..=MAX_BATCH_LEAVES).contains(&leaf_count),', 'leaf_count == leaf_count,')], [T30]),
    ('window-no-review', [(BATCH, '    earliest <= valid_from\n        && valid_from <= latest', '    now <= valid_from\n        && earliest <= earliest\n        && valid_from <= latest')], [T30]),
    ('window-no-max-lead', [(BATCH, '        && valid_from <= latest\n', '        && latest == latest\n')], [T30]),
    ('window-no-max-validity', [(BATCH, '        && valid_until <= last\n', '        && last == last\n')], [T30]),
    ('publication-always-moves-latest', [(BATCH, '    if lb.latest.seq != 0 && now >= lb.latest.valid_from {\n        lb.previous = lb.latest;', '    if lb.latest.seq != 0 {\n        lb.previous = lb.latest;')], [T30]),
    # clear_launch_batch (4.26)
    ('clear-by-anyone', [(HELP, '    *signer == lp.admin\n        || (lp.launch_approver != zero', '    true || *signer == lp.admin\n        || (lp.launch_approver != zero')], [T30]),
    # set_launch_approver (4.24)
    ('approver-no-separation', [(SLA, '    check_approver_separate(&approver, lp)?;\n', '')], [T30]),
    ('rotation-keeps-records', [(SLA, '    lb.latest.cleared = true;\n    lb.previous.cleared = true;\n    lb.halted = false;', '    lb.halted = false;')], [T30]),
    ('rotation-keeps-halt', [(SLA, '    lb.previous.cleared = true;\n    lb.halted = false;', '    lb.previous.cleared = true;')], [T30]),
    # the batch settings events are event CPIs, which padding cannot truncate (review R6-RT-3)
    ('publish-event-logged', [(PUB, 'emit_cpi!(LaunchBatchPublished {', 'emit!(LaunchBatchPublished {')], [T30]),
    ('clear-event-logged', [(CLR, 'emit_cpi!(LaunchBatchCleared {', 'emit!(LaunchBatchCleared {')], [T30]),
    ('approver-change-event-logged', [(SLA, 'emit_cpi!(LaunchApproverChanged {', 'emit!(LaunchApproverChanged {')], [T30]),
    # the approver kept apart both ways (4.4, 4.5, 4.2, 4.8, 4.17)
    ('guardian-may-be-approver', [(P + 'instructions/set_guardian.rs', '    check_not_approver(&guardian, &lp.launch_approver)?;\n', '')], [T30]),
    ('payout-key-may-be-approver', [(P + 'instructions/set_payout_config.rs', '        check_not_approver(&payout_authority, &lp.launch_approver)?;\n', '')], [T30]),
    ('payout-wallet-may-be-approver', [(P + 'instructions/set_payout_config.rs', '        check_not_approver(&payout_destination, &lp.launch_approver)?;\n', '')], [T30]),
    ('proposed-admin-may-be-approver', [(P + 'instructions/propose_admin.rs', '        check_not_approver(&new_admin, &lp.launch_approver)?;\n', '')], [T30]),
    ('approved-founder-may-be-approver', [(P + 'instructions/approve_launch.rs', '        &lp.payout_authority,\n        &lp.launch_approver,\n    )?;', '        &lp.payout_authority,\n        &Pubkey::default(),\n    )?;')], [T30]),
    ('new-founder-may-be-approver', [(P + 'instructions/transfer_founder.rs', '        &lp.payout_authority,\n        &lp.launch_approver,\n    )?;', '        &lp.payout_authority,\n        &Pubkey::default(),\n    )?;')], [T30]),
    # launch_from_batch (4.27) and 8.6
    ('batch-launch-while-paused', [(LFB, '    require!(!lp.launches_paused, CurveError::LaunchesPaused);\n', '')], [T30]),
    ('batch-launch-while-buys-halted', [(LFB, '    require!(!lp.buys_halted, CurveError::BuysHalted);\n', '')], [T30]),
    ('batch-launch-no-approver-check', [(LFB, '    require!(\n        lp.launch_approver != Pubkey::default(),\n        CurveError::LaunchApproverNotSet\n    );\n', '')], [T30]),
    ('batch-launch-while-path-halted', [(LFB, '    require!(!a.launch_batch.halted, CurveError::BatchesHalted);\n', '')], [T30]),
    ('in-force-previous-after-newer-began', [(BATCH, '    } else if batch_seq == lb.previous.seq && now < lb.latest.valid_from {', '    } else if batch_seq == lb.previous.seq {')], [T30]),
    ('in-force-any-publisher', [(BATCH, '        Some(b) if batch_seq != 0 && b.publisher == *launch_approver => b,', '        Some(b) if batch_seq != 0 => b,')], [T30]),
    ('in-force-ignores-clear', [(BATCH, '    require!(!b.cleared, CurveError::BatchCleared);\n', '')], [T30]),
    ('in-force-before-valid-from', [(BATCH, '    require!(now >= b.valid_from, CurveError::BatchNotYetValid);\n', '')], [T30]),
    ('in-force-after-valid-until', [(BATCH, '    require!(now <= b.valid_until, CurveError::BatchExpired);\n', '')], [T30]),
    ('batch-launch-city-zero', [(LFB, '    require!(city_id >= 1, CurveError::BadCityId);\n', '')], [T30]),
    ('batch-founder-holds-role', [(LFB, '    check_founder_key(\n        &founder,\n        &lp.guardian,\n        &lp.payout_authority,\n        &lp.launch_approver,\n    )?;\n', '')], [T30]),
    ('batch-launch-bad-meta-hash', [(LFB, '    require!(meta_hash != [0u8; 32], CurveError::BadMetaHash);\n', '')], [T30]),
    ('batch-launch-bad-name', [(LFB, '    check_name(&name)?;\n', '')], [T30]),
    ('proof-length-unbounded', [(LFB, '        proof.len() <= max_proof_len(b.leaf_count),', '        proof.len() <= 64,')], [T30]),
    ('proof-not-verified', [(LFB, '        verify_proof(&proof, &b.root, &leaf),', '        true || verify_proof(&proof, &b.root, &leaf),')], [T30]),
    ('pending-approval-ignored', [(LFB, '        constraint = is_empty_system_account(&approval) @ CurveError::ApprovalPending,\n', '')], [T30]),
    ('batch-launch-config-disabled', [(LFB, '        constraint = config.enabled @ CurveError::ConfigDisabled,\n', '')], [T30]),
    ('batch-launch-old-launches-open', [(LFB, '        constraint = legacy_launches_paused(&legacy_launchpad) @ CurveError::LegacyLaunchesOpen,\n', '')], [T30]),
    ('batch-launch-old-admin', [(LFB, "        constraint = legacy_admin_matches(&legacy_launchpad, &launchpad.admin)\n            @ CurveError::LegacyAdminMismatch,\n", '')], [T30]),
    ('batch-launch-registry-admin', [(LFB, "        constraint = rewards_registry_matches(&rewards_registry, &launchpad.admin)\n            @ CurveError::RewardsRegistryAdminMismatch,\n", '')], [T30]),
    ('batch-launch-old-coin', [(LFB, "        constraint = is_empty_system_account(&legacy_coin) @ CurveError::LegacyCoinExists,\n", '')], [T30]),
    ('batch-launch-old-approval', [(LFB, "        constraint = is_empty_system_account(&legacy_approval)\n            @ CurveError::LegacyApprovalExists,\n", '')], [T30]),
    ('batch-launch-other-metadata', [(LFB, "        constraint = metadata.key() == metadata_address(&mint.key()) @ CurveError::InvalidAddress,\n", '')], [T30]),
    # the halt-all build (8.3)
    ('halt-all-misses-batch-launch', [(LFB, '    require_not_halted()?;\n    let a = &ctx.accounts;', '    let a = &ctx.accounts;')], [(T11, 'H02')], 'halt-all'),
]


def patch(changes):
    saved = {}
    for f, old, new in changes:
        path = os.path.join(SOL, f)
        cur = open(path).read()
        saved.setdefault(path, cur)
        n = cur.count(old)
        if n != 1:
            restore(saved)
            raise SystemExit(f'{f}: pattern found {n} times: {old!r}')
        open(path, 'w').write(cur.replace(old, new))
    return saved


def restore(saved):
    for path, text in saved.items():
        open(path, 'w').write(text)


def run(cmd, env=None, timeout=1800):
    t = time.time()
    p = subprocess.run(cmd, cwd=SOL, env=env, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr, time.time() - t


results = []
for m in MUTANTS:
    name, changes, tests = m[0], m[1], m[2]
    feature = m[3] if len(m) > 3 else None
    if ONLY and name not in ONLY:
        continue
    out = os.path.join(OUT, name)
    os.makedirs(out, exist_ok=True)
    saved = patch(changes)
    try:
        cmd = ['cargo', 'build-sbf', '--manifest-path', 'programs/vicinity-curve/Cargo.toml', '--sbf-out-dir', out]
        if feature:
            cmd += ['--features', feature]
        code, log, secs = run(cmd)
    finally:
        restore(saved)
    if code != 0:
        results.append({'mutant': name, 'result': 'BUILD FAILED', 'log': log[-2000:]})
        print(json.dumps(results[-1]), flush=True)
        continue
    so = os.path.join(out, 'vicinity_curve.so')
    env = dict(os.environ)
    env['VCURVE_SO' if not feature else 'VCURVE_HALT_ALL_SO'] = so
    if os.environ.get('MUTANT_CHECKS_OFF') == '1':
        env['VCURVE_INVARIANTS'] = 'off'  # the explicit assertions alone, without the per-transaction checker
    killed_by = []
    for t in tests:
        f, pat = (t, None) if isinstance(t, str) else t
        cmd = ['node', '--test'] + (['--test-name-pattern', pat] if pat else []) + [f]
        code, log, secs = run(cmd, env=env)
        if code != 0:
            failing = [line[len('not ok '):].split(' - ', 1)[-1][:160] for line in log.splitlines() if line.startswith('not ok ')]
            killed_by.append({'file': f, 'failing': failing})
    results.append({'mutant': name, 'result': 'killed' if killed_by else 'SURVIVED', 'killedBy': killed_by})
    print(json.dumps(results[-1]), flush=True)
    os.remove(so)

json.dump(results, open(os.path.join(OUT, 'results-nochecks.json' if os.environ.get('MUTANT_CHECKS_OFF') == '1' else 'results.json'), 'w'), indent=1)
print(f"{sum(r['result'] == 'killed' for r in results)} killed of {len(results)}")

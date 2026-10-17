#!/usr/bin/env python3
"""Golden vectors for the Rust crate vicinity-curve-math.

model.py and checks.py are Appendix A of VICINITY-CURVE-DESIGN.md, copied
verbatim; `python3 checks.py` prints the figures recorded in the spec.
derive.py adds 5.9's integer search (derive_curve) on top of model.py.

This script drives model.py through random coin lives (launch, buys, sells,
partial fills, graduation, pool trades with the liquidity drip, buyback sizing,
bucket payouts, injected backlogs) on the default config and on random configs
that pass V1 to V11, plus standalone vectors for the fee split, the gross-up,
the curve functions, validate_config and derive_curve. It writes vectors.json,
which tests/differential.rs replays against the Rust crate with exact equality.
Every model operation is followed by model.Coin.check() (the reference
invariants), so a vector file can only be written from a consistent run.

    python3 generate_vectors.py          # rewrite vectors.json
    python3 generate_vectors.py --check  # regenerate in memory, compare
"""
import hashlib
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from model import (D, DEFAULT, MAX_DUST, MIN_TRADE, SUPPLY, Cfg, Coin,  # noqa: E402
                   cdiv, gross_for, rules, split)
from derive import derive_curve  # noqa: E402

SEED = 20261017
OUT = os.path.join(HERE, 'vectors.json')
U64 = (1 << 64) - 1
MAX_LAUNCH_FEE = 500_000_000

# Order of the numbers in every "state" array (tests/differential.rs uses the same order).
STATE_FIELDS = [
    'phase', 'tokens_sold', 'curve_sol', 'pool_sol', 'pool_tokens', 'liquidity_pending',
    'platform_pending', 'founder_pending', 'holders_pending', 'buyback_pending',
    'last_buyback_slot', 'trade_seq', 'buyback_count', 'tokens_burned', 'buy_volume',
    'sell_volume', 'fees_total', 'liquidity_earned', 'liquidity_added', 'platform_earned',
    'founder_earned', 'holders_earned', 'buyback_earned', 'buyback_spent',
    # not State fields: liabilities (model.Coin.lam, the lamports above rent) and the vault balance
    'liabilities', 'vault',
]
BUY_FIELDS = ['charged', 'net', 'tokens', 'fee', 'liq', 'liq_floor', 'plat', 'fdr', 'hld', 'bb',
              'drip', 'partial', 'grad']
SELL_FIELDS = ['gross', 'out', 'fee', 'liq', 'liq_floor', 'plat', 'fdr', 'hld', 'bb', 'drip']
SPLIT_FIELDS = ['fee', 'liq', 'liq_floor', 'plat', 'fdr', 'hld', 'bb']


def cfg_json(c):
    return dict(bps=list(c.bps), x0=c.x0, y0=c.y0, S=c.S, P=c.P, R=c.R)


class Life:
    """One coin from launch, with the counters model.py does not keep."""

    def __init__(self, cfg, slot):
        self.c = cfg
        self.m = Coin(cfg, slot=slot)
        self.trade_seq = self.buyback_count = self.buy_volume = self.sell_volume = 0
        self.held = [0, 0, 0, 0]
        self.ops = []
        self.launch_slot = slot

    def state(self):
        m = self.m
        return [m.phase, m.s, m.r, m.X, m.Y, m.L, m.pend['plat'], m.pend['fdr'], m.pend['hld'],
                m.pend['bb'], m.last_bb, self.trade_seq, self.buyback_count, m.burned,
                self.buy_volume, self.sell_volume, m.fees_total, m.earned['liq'],
                m.out['liq_added'], m.earned['plat'], m.earned['fdr'], m.earned['hld'],
                m.earned['bb'], m.out['bb'], m.lam, m.vault]

    def rec(self, op, arg, res):
        self.m.check()
        self.ops.append([op, arg, res, self.state()])

    def buy(self, G, user):
        try:
            q = self.m.buy(G)
        except ValueError as e:
            return self.rec('buy', G, str(e))
        self.held[user] += q['tokens']
        self.trade_seq += 1
        self.buy_volume += q['charged']
        self.rec('buy', G, [int(q[k]) for k in BUY_FIELDS])

    def sell(self, t, user):
        try:
            q = self.m.sell(t)
        except ValueError as e:
            return self.rec('sell', t, str(e))
        if self.held[user] >= t:
            self.held[user] -= t
        self.trade_seq += 1
        self.sell_volume += q['gross']
        self.rec('sell', t, [int(q[k]) for k in SELL_FIELDS])

    def buyback(self, slot):
        self.m.slot = slot
        r = self.m.buyback()
        if r is not None:
            self.buyback_count += 1
            r = [r['spent'], r['coins'], r['cap']]
        self.rec('buyback', slot, r)

    def pay(self, k):
        self.rec('pay_' + k, None, self.m.pay(k))

    def inject_bb(self, x):
        m = self.m
        m.pend['bb'] += x; m.earned['bb'] += x; m.lam += x; m.fees_total += x
        self.rec('inject_bb', x, None)

    def inject_liq(self, x):
        m = self.m
        m.L += x; m.earned['liq'] += x; m.lam += x; m.fees_total += x
        self.rec('inject_liq', x, None)

    def max_quote_in(self):
        if self.m.phase != 0:
            return self.rec('max_quote_in', None, 'WrongPhase')
        self.rec('max_quote_in', None, self.m.max_quote_in())


def buy_amount(rng, life):
    x = rng.random()
    if x < 0.04:
        return rng.choice([0, 1, MIN_TRADE - 1, MIN_TRADE, MIN_TRADE + 1])
    if life.m.phase == 0:
        if x < 0.05:
            return rng.randrange(MIN_TRADE, U64 + 1)      # always a partial fill on the curve
        if x < 0.10:
            return int(10 ** rng.uniform(10, 11.2))
        return int(10 ** rng.uniform(4.8, 10))
    return int(10 ** rng.uniform(4.8, 11.4))


def run_life(rng, cfg, n_ops, backlog=False):
    slot = rng.randrange(0, 10**9)
    life = Life(cfg, slot)
    if backlog:
        life.inject_bb(rng.choice([10**9, 10**11, 10**13]))
    while len(life.ops) < n_ops:
        m = life.m
        slot += rng.choice([0, 0, 1, 10, 50, 149, 150, 151, 400])
        u = rng.randrange(4)
        r = rng.random()
        if r < 0.38:
            life.buy(buy_amount(rng, life), u)
        elif r < 0.68:
            x = rng.random()
            if x < 0.04 and m.phase == 0:
                life.sell(min(U64, m.s + rng.randint(1, 10**6)), u)   # SellExceedsCurve
            elif x < 0.07:
                life.sell(0, u)                                       # ZeroAmount
            elif x < 0.14:
                life.sell(rng.randint(1, 3000), u)                    # flat steps, ZeroOutput
            elif life.held[u]:
                h = life.held[u]
                life.sell(rng.randint(1, h) if rng.random() < 0.7 else h, u)
            else:
                life.buy(buy_amount(rng, life), u)
        elif r < 0.80:
            life.buyback(slot)
        elif r < 0.86:
            life.pay(rng.choice(['plat', 'fdr', 'hld']))
        elif r < 0.89:
            life.max_quote_in()
        elif r < 0.96 and m.phase == 0 and m.r * 10 >= cfg.R * 6:
            rem = cfg.R - m.r
            k = rng.randrange(5)
            if k == 0:
                life.buy(m.max_quote_in(), u)                         # completes exactly
            elif k == 1:
                life.buy(max(MIN_TRADE, m.max_quote_in() - 1), u)
            elif k == 2 and rem >= 2:
                life.buy(gross_for(cfg, rem - 1), u)                  # to R - 1 when net allows
                life.buy(MIN_TRADE + rng.randrange(10**6), u)         # rem = 1: charged 1, fee 0
            elif k == 3:
                life.buy(gross_for(cfg, rem) + rng.randrange(10**10), u)   # partial fill
            else:
                life.buy(gross_for(cfg, rng.randint(1, rem)), u)
        elif r < 0.98:
            life.inject_bb(int(10 ** rng.uniform(6, 12)))
        elif m.phase == 1 or rng.random() < 0.3:
            life.inject_liq(int(10 ** rng.uniform(6, 11.5)))
        else:
            life.buy(buy_amount(rng, life), u)
    return dict(config=cfg_json(cfg), launch_slot=life.launch_slot, ops=life.ops)


def random_bps(rng):
    return (rng.randint(0, 120), rng.randint(0, 120), rng.randint(0, 120), rng.randint(0, 120),
            rng.randint(0, 60))


def random_valid_cfg(rng, r_hi=13.0):
    while True:
        dust = rng.choice([0, 9_100_000, rng.randint(0, MAX_DUST)])
        P = rng.randint(10**13, 45 * 10**13)
        S = SUPPLY - dust - P
        R = int(10 ** rng.uniform(9, r_hi))
        d = derive_curve(S, P, R, radius=64)
        if d is None:
            continue
        for _ in range(50):
            cfg = Cfg(d[0], d[1], S, P, R, bps=random_bps(rng), validate=False)
            if rules(cfg) is None:
                return cfg


def first_rule(c, fee):
    """validate_config's first failing rule in table order, V9 included (model.rules skips V9)."""
    r = rules(c)
    if fee > MAX_LAUNCH_FEE and r in (None, 'V10', 'V11'):
        return 'V9'
    return r


def mutate(rng, base):
    v = dict(bps=list(base.bps), x0=base.x0, y0=base.y0, S=base.S, P=base.P, R=base.R,
             fee=rng.choice([0, 50_000_000, MAX_LAUNCH_FEE]))
    for _ in range(rng.choice([0, 1, 1, 1, 2, 3])):
        k = rng.choice(['bps', 'bps', 'x0', 'y0', 'S', 'P', 'R', 'fee'])
        if k == 'bps':
            i = rng.randrange(5)
            v['bps'][i] = rng.choice([0, 1, 30, 50, 58, 59, 60, 70, 100, 101, 120, 121, 170, 250, 251,
                                      65535, rng.randint(0, 300)])
        elif k == 'fee':
            v['fee'] = rng.choice([MAX_LAUNCH_FEE + 1, U64, rng.randint(0, 10**9)])
        else:
            x = v[k]
            v[k] = max(0, min(U64, rng.choice([
                x + 1, x - 1, x + rng.randint(-1000, 1000), x * 2, x // 2, 0, 1,
                2**60, 2**60 + 1, U64, x + rng.randint(-10**9, 10**9)])))
    return v


def curve_candidates(S, P, R, x0s):
    """(x0, y0) with exact completion f(S) = R and the largest such d, for each x0 (no other rule)."""
    out = []
    for x0 in x0s:
        if x0 < 1:
            continue
        a = x0 * S
        d_hi = (a - 1) // (R - 1)
        if d_hi < cdiv(a, R):
            continue
        out.append((x0, S + d_hi))
    return out


def v6_case(rng):
    # R close to or above P: the curve cannot absorb every lamport (V6 fails, V1 to V5 pass)
    P = rng.randint(10**12, 10**13)
    S = SUPPLY - rng.randint(0, MAX_DUST) - P
    R = rng.randint(P // 2, 10**13)
    x0s = [R * P // (S - P) + k for k in range(-3, 4)]
    return [(S, P, R, x0, y0) for x0, y0 in curve_candidates(S, P, R, x0s)]


def v7_case(rng, base):
    # Exact completion kept, x0 moved away from x0*: continuity above the curve or beyond 1e-9
    k = rng.choice([1, 2, 50, 10**3, 10**6, 10**9])
    x0 = base.x0 + rng.choice([-k, k])
    return [(base.S, base.P, base.R, a, b) for a, b in curve_candidates(base.S, base.P, base.R, [x0])]


def gen_validate(rng, n):
    out = []
    bases = [DEFAULT] + [random_valid_cfg(rng) for _ in range(12)]
    while len(out) < n:
        fam = rng.random()
        if fam < 0.06:
            for S, P, R, x0, y0 in v6_case(rng)[:2]:
                v = dict(bps=[50, 70, 50, 50, 30], x0=x0, y0=y0, S=S, P=P, R=R, fee=0)
                c = Cfg(x0, y0, S, P, R, bps=tuple(v['bps']), validate=False)
                out.append(dict(params=v, rule=first_rule(c, 0)))
            continue
        if fam < 0.14:
            b = rng.choice(bases)
            for S, P, R, x0, y0 in v7_case(rng, b):
                v = dict(bps=list(b.bps), x0=x0, y0=y0, S=S, P=P, R=R, fee=0)
                c = Cfg(x0, y0, S, P, R, bps=b.bps, validate=False)
                out.append(dict(params=v, rule=first_rule(c, 0)))
            continue
        if fam < 0.50:
            b = rng.choice(bases)
            bps = list(random_bps(rng)) if rng.random() < 0.5 else list(b.bps)
            for _ in range(rng.choice([1, 1, 2])):
                bps[rng.randrange(5)] = rng.choice([0, 1, 30, 50, 51, 58, 59, 60, 61, 69, 70, 71,
                                                    99, 100, 101, 119, 120, 121, 170, 250, 251])
            v = dict(bps=bps, x0=b.x0, y0=b.y0, S=b.S, P=b.P, R=b.R,
                     fee=rng.choice([0, 50_000_000, MAX_LAUNCH_FEE, MAX_LAUNCH_FEE + 1]))
            c = Cfg(b.x0, b.y0, b.S, b.P, b.R, bps=tuple(bps), validate=False)
            out.append(dict(params=v, rule=first_rule(c, v['fee'])))
            continue
        if fam < 0.56:
            v = dict(bps=[rng.randint(0, 300) for _ in range(5)],
                     x0=rng.randrange(U64 + 1) >> rng.randrange(64),
                     y0=rng.randrange(U64 + 1) >> rng.randrange(64),
                     S=rng.randrange(SUPPLY + 1), P=rng.randrange(SUPPLY + 1),
                     R=rng.randrange(U64 + 1) >> rng.randrange(64), fee=rng.randrange(10**9))
        else:
            v = mutate(rng, rng.choice(bases))
        c = Cfg(v['x0'], v['y0'], v['S'], v['P'], v['R'], bps=tuple(v['bps']), validate=False)
        out.append(dict(params=v, rule=first_rule(c, v['fee'])))
    # V2b (review ECON-1), fixed cases after the seeded ones (no random draw, so every other vector is unchanged):
    # the founder or the holders credited the whole fee, the 1-bp edge, and configs that stay valid
    for bps in ([0, 0, 100, 0, 0], [0, 0, 0, 100, 0], [0, 0, 1, 0, 0], [0, 0, 0, 250, 0], [0, 1, 100, 0, 0],
                [0, 1, 0, 100, 0], [0, 20, 100, 0, 0], [0, 1, 0, 0, 0], [0, 0, 100, 0, 1]):
        b = DEFAULT
        v = dict(bps=list(bps), x0=b.x0, y0=b.y0, S=b.S, P=b.P, R=b.R, fee=0)
        c = Cfg(b.x0, b.y0, b.S, b.P, b.R, bps=tuple(bps), validate=False)
        out.append(dict(params=v, rule=first_rule(c, 0)))
    return out


def gen_fee_split(rng, n):
    out = []
    for i in range(n):
        bps = [50, 70, 50, 50, 30] if i % 3 == 0 else [rng.randint(0, 1999) for _ in range(5)]
        A = rng.choice([rng.randrange(10**6), int(10 ** rng.uniform(0, 13)), rng.randrange(U64 + 1)])
        c = Cfg(1, 2, 1, 1, 1, bps=tuple(bps), validate=False)
        sp = split(c, A)
        out.append(dict(bps=bps, amount=A, split=[sp[k] for k in SPLIT_FIELDS]))
    return out


def gen_gross_for(rng, n):
    out = []
    for i in range(n):
        t = rng.choice([1, 37, 249, 250, rng.randint(0, 250), rng.randint(0, D - 1)])
        net = rng.choice([1, 2, rng.randint(1, 10**6), int(10 ** rng.uniform(0, 13)),
                          rng.randint(1, 10**18)])
        c = Cfg(1, 2, 1, 1, 1, bps=(t, 0, 0, 0, 0), validate=False)
        g = gross_for(c, net)
        out.append(dict(t=t, net=net, gross=g if g <= U64 else None))   # None: leaves u64 (Overflow)
    return out


def gen_curve(rng, n):
    out = []
    cfgs = [DEFAULT] + [random_valid_cfg(rng) for _ in range(6)]
    for i in range(n):
        c = cfgs[i % len(cfgs)]
        s = rng.choice([0, 1, c.S - 1, c.S, rng.randint(0, c.S)])
        q = rng.choice([0, 1, c.R - 1, c.R, rng.randint(0, 2 * c.R)])
        out.append(dict(config=cfg_json(c), s=s, f=c.f(s), q=q, tokens_for=c.tokens_for(q)))
    return out


def gen_derive(rng, n):
    cases = [(DEFAULT.S, DEFAULT.P, DEFAULT.R), (DEFAULT.S, 206_900_010_000_000, DEFAULT.R),
             (DEFAULT.P, DEFAULT.S, DEFAULT.R), (10**14, 10**14, 10**10)]
    while len(cases) < n:
        dust = rng.randint(0, MAX_DUST)
        P = rng.randint(10**13, 45 * 10**13)
        cases.append((SUPPLY - dust - P, P, int(10 ** rng.uniform(9, 13))))
    out = []
    for S, P, R in cases:
        d = derive_curve(S, P, R)
        out.append(dict(S=S, P=P, R=R, result=None if d is None else list(d)))
    return out


def generate():
    rng = random.Random(SEED)
    lives = []
    for i in range(20):
        lives.append(run_life(rng, DEFAULT, 180, backlog=(i % 4 == 3)))
    for i in range(10):
        lives.append(run_life(rng, random_valid_cfg(rng, r_hi=11.4), 160, backlog=(i % 3 == 2)))
    disc = {name: list(hashlib.sha256(('account:' + name).encode()).digest()[:8])
            for name in ('CurveCoin', 'Coin')}
    return dict(
        about='Generated by generate_vectors.py from model.py (VICINITY-CURVE-DESIGN.md '
              'Appendix A); replayed by tests/differential.rs. Do not edit by hand.',
        seed=SEED,
        state_fields=STATE_FIELDS, buy_fields=BUY_FIELDS, sell_fields=SELL_FIELDS,
        split_fields=SPLIT_FIELDS,
        discriminators=disc,
        lives=lives,
        fee_split=gen_fee_split(rng, 400),
        gross_for=gen_gross_for(rng, 400),
        curve=gen_curve(rng, 400),
        validate=gen_validate(rng, 1500),
        derive=gen_derive(rng, 12),
    )


def dump(v):
    # One life operation per line keeps the file reviewable and diffs small.
    lines = ['{']
    keys = list(v.keys())
    for i, k in enumerate(keys):
        sep = ',' if i + 1 < len(keys) else ''
        if k == 'lives':
            lines.append(' "lives": [')
            for j, life in enumerate(v[k]):
                lines.append('  {"config": %s, "launch_slot": %d, "ops": [' % (
                    json.dumps(life['config'], separators=(',', ':')), life['launch_slot']))
                for n, op in enumerate(life['ops']):
                    lines.append('   ' + json.dumps(op, separators=(',', ':')) +
                                 (',' if n + 1 < len(life['ops']) else ''))
                lines.append('  ]}' + (',' if j + 1 < len(v[k]) else ''))
            lines.append(' ]' + sep)
        elif isinstance(v[k], list) and v[k] and isinstance(v[k][0], dict):
            lines.append(' %s: [' % json.dumps(k))
            for n, e in enumerate(v[k]):
                lines.append('  ' + json.dumps(e, separators=(',', ':')) + (',' if n + 1 < len(v[k]) else ''))
            lines.append(' ]' + sep)
        else:
            lines.append(' %s: %s%s' % (json.dumps(k), json.dumps(v[k], separators=(',', ':')), sep))
    lines.append('}')
    return '\n'.join(lines) + '\n'


def main():
    text = dump(generate())
    if '--check' in sys.argv:
        with open(OUT) as f:
            same = f.read() == text
        print('vectors.json is up to date' if same else 'vectors.json differs from the generator')
        sys.exit(0 if same else 1)
    with open(OUT, 'w') as f:
        f.write(text)
    v = json.loads(text)
    ops = sum(len(life['ops']) for life in v['lives'])
    kinds = {}
    for life in v['lives']:
        for name, _arg, res, st in life['ops']:
            key = name + (':' + res if isinstance(res, str) else '')
            if name == 'buy' and isinstance(res, list):
                key += ':grad' if res[12] else (':partial' if res[11] else '')
                key += ':pool' if st[0] == 1 and not res[12] else ''
            if name == 'sell' and isinstance(res, list):
                key += ':pool' if st[0] == 1 else ':curve'
                key += ':drip' if res[9] else ''
            if name == 'buyback':
                key += ':noop' if res is None else (':pool' if st[0] == 1 else ':curve')
            kinds[key] = kinds.get(key, 0) + 1
    print('wrote', OUT, 'lives', len(v['lives']), 'life operations', ops)
    for k in sorted(kinds):
        print('  %-28s %d' % (k, kinds[k]))
    print('fee_split', len(v['fee_split']), 'gross_for', len(v['gross_for']), 'curve', len(v['curve']),
          'validate', len(v['validate']), 'derive', len(v['derive']))
    rules_seen = {}
    for e in v['validate']:
        rules_seen[e['rule']] = rules_seen.get(e['rule'], 0) + 1
    print('validate rules', dict(sorted(rules_seen.items(), key=lambda kv: str(kv[0]))))


if __name__ == '__main__':
    main()

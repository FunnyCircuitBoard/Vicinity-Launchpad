# Checks behind VICINITY-CURVE-DESIGN.md sections 5, 7 and 12 (run: python3 checks.py)
import copy, math, random
from fractions import Fraction as Fr
import model
from model import *

c = DEFAULT
d = c.y0 - c.S
assert rules(c) is None                                            # V1 to V11 (V9 not modelled)
assert (c.R - 1) * d < c.x0 * c.S <= c.R * d                       # f(S) = R exactly
assert c.f(c.S - 1) == c.R - 1                                     # V5b
gap = (c.x0 + c.R) * c.P - c.R * d
print("continuity gap", gap, float(Fr(gap, (c.x0 + c.R) * c.P)), "absorption", float(Fr(d * d, c.x0 * c.y0)))
t, C = c.t, CAP_DIV
m_ = max(c.fdr, c.hld); L_ = c.liq
v8l = 100 * ((C * D + t) ** 2 * (D - t + 2 * L_ + m_) * (D - t + 2 * L_) + m_ * D * (C * D) ** 2); v8r = 99 * (C * D) ** 2 * D ** 2
print("V8", v8l, v8r, "bound %.5f" % (float(Fr(v8l, v8r)) * 0.99))
print("V11", C * (D - t) * (D - t + 2 * L_), D * (C * D - 38 * t), C * (D - t + 2 * L_) * (D - t + m_), (D - m_) * (C * D - 28 * t))

# Lemma G (gross-up) and Lemma F (split) exhaustively on small values
for tt in (1, 37, 249, 250):
    for cc in range(1, 200_000):
        G = ((cc - 1) * D) // (D - tt) + 1
        assert G - G * tt // D == cc and (G - 1) - (G - 1) * tt // D == cc - 1
for tt in range(1, 251):
    for cc in range(1, 2_000):
        G = ((cc - 1) * D) // (D - tt) + 1
        assert G - G * tt // D == cc and (G - 1) - (G - 1) * tt // D == cc - 1
first4 = None
for A in range(1, 1_000_000):
    sp = split(c, A)
    if first4 is None and sp['liq'] - sp['liq_floor'] == 4: first4 = A
rng = random.Random(1)
for _ in range(100_000): split(c, rng.randrange(1 << 64))
print("split remainder bound 4 first reached at A =", first4)

def ex(label, q, keys):
    print(label, {k: q[k] for k in keys})
B = ('charged', 'net', 'tokens', 'fee', 'liq', 'plat', 'fdr', 'hld', 'bb')
Sl = ('gross', 'out', 'fee', 'liq', 'plat', 'fdr', 'hld', 'bb')
m = Coin(c); ex("E1", m.buy(10**9), B); m.check(); print("   virtual", m.virt())
ex("E2", m.sell(m.s), Sl); m.check(); assert m.s == 0 and m.r == 0; print("   L", m.L, m.pend)
m = Coin(c); ex("E3", m.buy(100 * 10**9), B + ('grad', 'partial')); m.check(); print("   pool", m.X, m.Y, m.L)
q4 = m.buy(10**9); ex("E4", q4, B + ('drip',)); m.check(); print("   pool", m.X, m.Y, m.L)
ex("E5", m.sell(q4['tokens']), Sl + ('drip',)); m.check(); print("   pool", m.X, m.Y, m.L)
m = Coin(c); m.buy(gross_for(c, 84_500_000_000)); print("E6 setup", gross_for(c, 84_500_000_000), m.s, m.r, "max_quote_in", m.max_quote_in())
ex("E6", m.buy(10**9), B + ('grad', 'partial')); m.check()
m = Coin(c, slot=0); m.buy(100 * 10**9); m.slot = 150; print("E7", m.buyback(), m.X, m.Y, m.supply, m.pend['bb']); m.check()
m = Coin(c, slot=0); q = m.buy(10 * 10**9); m.slot = 150; print("E8", q['tokens'], m.depth(), m.buyback(), m.s, m.r); m.check()
ex("E9", Coin(c).quote_buy(MIN_TRADE), B)
m = Coin(c); m.buy(gross_for(c, c.f(c.S - 1))); assert m.r == c.R - 1
q = m.quote_buy(10**10); print("rem=1 graduating buy", q['charged'], q['fee'], q['tokens'], q['grad'])
m2 = copy.deepcopy(m); m2.s = c.tokens_for(c.R - 2) + 1; m2.pend['bb'] = m2.earned['bb'] = 10**9; m2.lam += 10**9; m2.fees_total += 10**9; m2.slot = 10**6
assert m2.s < c.S - 1 and c.f(m2.s) == c.R - 1 and m2.buyback() is None    # I22: no-op when curve_sol == f(S-1)
print("last flat step below S-1:", c.S - 1 - m2.s, "raw units; buyback there is a no-op")
assert rules(Cfg(c.x0, c.y0, c.S, c.P, c.R, bps=(50, 0, 170, 0, 30), validate=False)) == 'V2'
m = Coin(c); m.buy(100 * 10**9); print("1 SOL just after graduation", m.quote_buy(10**9)['tokens'])
print("caps: launch", Coin(c).cap(), "end of curve", (c.x0 + c.R) * t // (C * D), "pool open", c.R * t // (C * D),
      "pool minimum", (c.R * c.P // SUPPLY) * t // (C * D))

# Buyback sandwiches (one run between the legs): canonical scan, random multi-leg, founder credited
def state(cfg, kind, amount, backlog=10**15):
    m = Coin(cfg, slot=0)
    if kind == 'curve':
        if amount: m.buy(gross_for(cfg, amount))
    else:
        m.buy(100 * 10**9); m.L += amount; m.lam += amount; m.earned['liq'] += amount; m.fees_total += amount
    m.pend['bb'] += backlog; m.earned['bb'] += backlog; m.lam += backlog; m.fees_total += backlog
    m.slot = 10**6
    return m
def sandwich(m0, a, legs_b, legs_s, rng, credit=()):
    m = copy.deepcopy(m0); paid = got = coins = 0; snap = dict(m.pend)
    cuts = sorted(rng.randint(MIN_TRADE, a) for _ in range(legs_b - 1))
    for p in [y - x for x, y in zip([0] + cuts, cuts + [a])]:
        if p >= MIN_TRADE:
            q = m.buy(p); paid += q['charged']; coins += q['tokens']
    if m.buyback() is None: return None
    left = coins
    for i in range(legs_s - 1):
        tk = rng.randint(1, left)
        try: q = m.sell(tk); got += q['out']; left -= tk
        except ValueError: pass
        if left == 0: break
    if left: got += m.sell(left)['out']
    m.check()
    got += sum(m.pend[k] - snap[k] for k in credit)
    return Fr(got - paid, paid)
kinds = [('curve', 0), ('curve', 10 * 10**9), ('curve', 40 * 10**9), ('curve', 80 * 10**9),
         ('pool', 0), ('pool', 10 * 10**9), ('pool', 200 * 10**9)]
def scan(cfg, credit, n_multi, seed):
    rng = random.Random(seed)
    b1 = max(sandwich(state(cfg, *k), int(10**6 * 1.5**i), 1, 1, rng, credit) for k in kinds for i in range(40))
    bm = max(r for k in kinds for _ in range(n_multi)
             for r in [sandwich(state(cfg, *k), int(10**rng.uniform(5.5, 12.3)), rng.randint(1, 6), rng.randint(1, 6), rng, credit)] if r is not None)
    return b1, bm
for credit in [(), ('fdr',), ('fdr', 'hld')]:
    b1, bm = scan(c, credit, 300, 7)
    print("sandwich credited %-14s canonical %.4f%%, multi-leg %.4f%%" % (credit, 100 * b1, 100 * bm))
    assert b1 < 0 and bm < 0

# Where single-run profit would start (step varied; curve; small to large attackers)
real_cap = Coin.cap
for bps in [10, 50, 100, 150, 200, 250, 260, 300]:
    Coin.cap = lambda s, bps=bps: s.depth() * bps // D
    rng = random.Random(3)
    best = max(sandwich(state(c, 'curve', k), int(10**6 * 1.5**i), 1, 1, rng) for k in (0, 40 * 10**9) for i in range(40))
    print("step %d bps: best canonical (curve) %+.2f%%" % (bps, 100 * best))
Coin.cap = real_cap

# Hold-through (Theorem M_K): buy, K buyback runs with no other trade, sell
f_, l_ = Fr(c.t, D), Fr(c.liq, D)
def hold(m0, a, K, credit=()):
    m = copy.deepcopy(m0); snap = dict(m.pend)
    q = m.buy(a); coins, paid = q['tokens'], q['charged']; X1 = m.depth(); spent = runs = 0
    for _ in range(K):
        r = m.buyback()
        if r is None: break
        spent += r['spent']; runs += 1; m.slot += INTERVAL
    out = m.sell(coins)['out'] + sum(m.pend[k] - snap[k] for k in credit); m.check()
    return Fr(out - paid, paid), Fr(spent, X1), runs
ustar = {'curve': 1 / math.sqrt(float((1 - f_) ** 2)) - 1, 'pool': 1 / math.sqrt(float((1 - f_) * (1 - f_ + 2 * l_))) - 1}
print("break-even backlog/depth u*: curve %.4f%%, pool %.4f%%" % (100 * ustar['curve'], 100 * ustar['pool']))
for kind, raised in [('curve', 0), ('curve', 40 * 10**9), ('pool', 0)]:
    for a in (10**8, 10**10):
        row = []; kstar = None
        for K in range(1, 31):
            res, u, runs = hold(state(c, kind, raised), a, K)
            row.append(res)
            if kstar is None and res > 0: kstar = K
        print("M_K %s %g SOL raised, attacker %g SOL: K=1 %+.2f%% K=20 %+.2f%% K=30 %+.2f%%, first profit at K=%s" %
              (kind, raised / 1e9, a / 1e9, 100 * row[0], 100 * row[19], 100 * row[29], kstar))
for kind, raised in [('curve', 0), ('pool', 0)]:
    kstar = next(K for K in range(1, 61) if hold(state(c, kind, raised), 10**8, K, ('fdr',))[0] > 0)
    print("founder-credited first profit", kind, "K =", kstar)
# backlog sweep (P06b): total buyback_pending as a fraction of depth, up to 400 runs; profit only above u*
for kind, raised in [('curve', 0), ('curve', 40 * 10**9), ('pool', 0)]:
    m0 = state(c, kind, raised, 0); depth0 = m0.depth(); have = m0.pend['bb']; first_pos = None; last_neg = None
    for ub in [5, 10, 15, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 50, 100]:      # in 0.1% of depth
        mb = state(c, kind, raised, max(0, depth0 * ub // 1000 - have))
        for a in (10**8, 10**9, 10**10):
            res, u, runs = hold(mb, a, 400)
            lim = (1 + u) ** 2 * (1 - f_) * (1 - f_ + (2 * l_ if kind == 'pool' else 0))
            assert res <= lim - 1 + Fr(1, 10**6), (kind, ub, a)
            if res > 0:
                assert float(u) > ustar[kind]
                if first_pos is None: first_pos = (ub / 10, a / 1e9, runs, round(float(100 * res), 3))
            elif first_pos is None: last_neg = (ub / 10, a / 1e9, round(float(100 * res), 3))
    print("backlog sweep", kind, raised / 1e9, "SOL raised: last loss", last_neg, "first profit (backlog % of depth, attacker SOL, runs, result %):", first_pos)

# Drip farming (7.5): attacker holds the float, credited the founder, holder and buyback shares
def farm(cfg, Lx, w, N, keys=('fdr', 'hld', 'bb')):
    m = Coin(cfg, slot=0); held = m.buy(100 * 10**9)['tokens']
    m.L += Lx; m.lam += Lx; m.earned['liq'] += Lx; m.fees_total += Lx
    base = copy.deepcopy(m); s0 = dict(base.pend); out0 = base.sell(held)['out'] + sum(base.pend[k] - s0[k] for k in keys)
    snap = dict(m.pend); cash = 0
    for _ in range(N):
        q = m.buy(w); cash -= q['charged']; cash += m.sell(q['tokens'])['out']
        if m.L == 0: break
    cash += m.sell(held)['out'] + sum(m.pend[k] - snap[k] for k in keys); m.check()
    return Fr(cash - out0, 10**9)
def best_farm(cfg):
    return max(farm(cfg, Lx, w, 300) for Lx in (0, 4 * 10**9, 20 * 10**9) for w in (10**8, 10**9, 10**10, 5 * 10**10))
mk = lambda bps: Cfg(c.x0, c.y0, c.S, c.P, c.R, bps=bps, validate=False)
for bps in [(50, 70, 50, 50, 30), (50, 51, 50, 50, 30), (50, 50, 50, 50, 30), (100, 50, 50, 50, 0), (250, 0, 0, 0, 0)]:
    cfg = mk(bps); print("drip farming", bps, "rule", rules(cfg), "best gain %.4f SOL" % float(best_farm(cfg)))
rng = random.Random(9); tested = 0; worst = None
while tested < 25:
    L = rng.randint(0, 120); Pl = rng.randint(0, 120); F = rng.randint(0, 120); H = rng.randint(0, 120); Bb = rng.randint(0, 60)
    cfg = mk((L, Pl, F, H, Bb))
    if rules(cfg) is not None: continue
    g = best_farm(cfg); tested += 1; worst = g if worst is None else max(worst, g)
    assert g < 0, (L, Pl, F, H, Bb, float(g))
print("drip farming, 25 random configs passing V1 to V11: best gain %.4f SOL" % float(worst))

# fuzz with invariants after every step, and round trips
rng = random.Random(2026); n = dict(buy=0, sell=0, bb=0, pay=0, grad=0)
for run in range(300):
    m = Coin(c, slot=0); held = [0] * 5
    for step in range(400):
        m.slot += rng.choice([0, 1, 10, 50, 200]); op = rng.random(); u = rng.randrange(5)
        try:
            if op < 0.45:
                q = m.buy(int(10**rng.uniform(5, 11.3))); held[u] += q['tokens']; n['buy'] += 1; n['grad'] += q['grad']
                assert q['grad'] or not q['partial']
            elif op < 0.8 and held[u]:
                tk = rng.randint(1, held[u]) if rng.random() < 0.7 else held[u]; m.sell(tk); held[u] -= tk; n['sell'] += 1
            elif op < 0.9:
                n['bb'] += m.buyback() is not None
            else:
                m.pay(rng.choice(['plat', 'fdr', 'hld'])); n['pay'] += 1
        except ValueError:
            pass
        m.check()
print("fuzz", n)
worst = -1
for i in range(20000):
    m = Coin(c, slot=0)
    try: m.buy(int(10**rng.uniform(5, 11.4)))
    except ValueError: pass
    if m.phase == 1:
        L = int(10**rng.uniform(6, 11)); m.L += L; m.lam += L; m.earned['liq'] += L; m.fees_total += L
    try: q = m.buy(int(10**rng.uniform(5, 12))); q2 = m.sell(q['tokens'])
    except ValueError: continue
    worst = max(worst, Fr(q2['out'] - q['charged'], q['charged']))
print("round trip least loss %.4f%%" % (-100 * worst)); assert worst < 0

# overflow: q * y0 in the buyback's tokens_for at x0 = y0 = 2^60, t = 250, R = 10^13
x0 = y0 = 2**60; Rm = 10**13
bmax = (x0 + Rm) * 250 // (CAP_DIV * D)
print("max q*y0 %.3e (u128 max %.3e)" % ((Rm + bmax) * y0, U128))

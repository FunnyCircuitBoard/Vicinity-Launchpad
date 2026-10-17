# Reference model of VICINITY-CURVE-DESIGN.md sections 5 to 7 (exact integers).
D = 10_000
SUPPLY = 10**15
MIN_TRADE = 100_000
MAX_DUST = 10**9
U64 = (1 << 64) - 1
U128 = (1 << 128) - 1
INTERVAL = 150
CAP_DIV = 25                 # BUYBACK_CAP_DIVISOR: a run spends at most depth*t/(25*D)
K_MIN, K_MIN_F = 20, 15      # V11 horizons (any trader / founder-credited)

def cdiv(a, b):
    assert a >= 0 and b > 0
    return -(-a // b)

def chk(*v):
    for x in v:
        assert 0 <= x <= U128, x

class Cfg:
    def __init__(s, x0, y0, S, P, R, bps=(50, 70, 50, 50, 30), validate=True):
        s.x0, s.y0, s.S, s.P, s.R = x0, y0, S, P, R
        s.bps = bps
        s.liq, s.plat, s.fdr, s.hld, s.bb = bps
        s.t = sum(bps)
        s.dust = SUPPLY - S - P
        if validate:
            v = rules(s)
            assert v is None, v
    def f(s, k):
        chk(s.x0 * k)
        return cdiv(s.x0 * k, s.y0 - k)
    def tokens_for(s, q):
        chk(q * s.y0)
        return (q * s.y0) // (s.x0 + q)

def rules(c):
    """validate_config V1 to V11 (V9, the launch fee cap, is not modelled). Returns the first failing rule."""
    L, Pl, F, H, B = c.bps; t = c.t; C = CAP_DIV
    if not (1 <= t <= 250): return 'V1'
    if Pl > 120 or F > 100 or t - F - H < 1: return 'V2'   # V2b: the credited shares leave 1 bp
    if not (c.S >= 1 and c.P >= 1 and c.S + c.P <= SUPPLY and SUPPLY - c.S - c.P <= MAX_DUST): return 'V3'
    if not (1 <= c.x0 <= 2**60 and c.S < c.y0 <= 2**60 and c.x0 * t >= C * D
            and c.R * c.P * t >= C * D * SUPPLY): return 'V4'
    if not (10**9 <= c.R <= 10**13 and cdiv(c.x0 * c.S, c.y0 - c.S) == c.R
            and cdiv(c.x0 * (c.S - 1), c.y0 - c.S + 1) <= c.R - 1): return 'V5'
    if c.x0 * c.y0 > (c.y0 - c.S) ** 2: return 'V6'
    g = (c.x0 + c.R) * c.P - c.R * (c.y0 - c.S)
    if not (0 <= g <= (c.x0 + c.R) * c.P // 10**9): return 'V7'
    m = max(F, H)
    if B > 0 and 100 * ((C * D + t) ** 2 * (D - t + 2 * L + m) * (D - t + 2 * L) + m * D * (C * D) ** 2) \
            > 99 * (C * D) ** 2 * D ** 2: return 'V8'
    if not (L == 0 or L < Pl): return 'V10'
    if B > 0 and not (C * (D - t) * (D - t + 2 * L) <= D * (C * D - 2 * (K_MIN - 1) * t)
                      and C * (D - t + 2 * L) * (D - t + m) <= (D - m) * (C * D - 2 * (K_MIN_F - 1) * t)): return 'V11'
    return None

def split(c, A):
    chk(A * c.t)
    fee = A * c.t // D                                    # rounded DOWN: never above t/D
    p, fo, h, b = A * c.plat // D, A * c.fdr // D, A * c.hld // D, A * c.bb // D
    l = fee - p - fo - h - b                              # liquidity = remainder
    lo = A * c.liq // D
    assert lo <= l <= lo + 4 and fee * D <= A * c.t, (A, l, lo)
    return dict(fee=fee, liq=l, liq_floor=lo, plat=p, fdr=fo, hld=h, bb=b)

def gross_for(c, net):
    """Least G with G - floor(G*t/D) == net (net >= 1): Lemma G."""
    assert net >= 1
    return ((net - 1) * D) // (D - c.t) + 1

class Coin:
    def __init__(s, c, slot=0):
        s.c = c; s.phase = 0; s.s = 0; s.r = 0; s.X = 0; s.Y = 0; s.L = 0
        s.pend = dict(plat=0, fdr=0, hld=0, bb=0)
        s.earned = dict(liq=0, plat=0, fdr=0, hld=0, bb=0)
        s.out = dict(liq_added=0, plat=0, fdr=0, hld=0, bb=0)
        s.fees_total = 0; s.burned = 0; s.lam = 0
        s.vault = c.S + c.P; s.supply = SUPPLY - c.dust; s.last_bb = slot; s.slot = slot
    def reserve(s): return s.r if s.phase == 0 else s.X
    def depth(s): return s.c.x0 + s.r if s.phase == 0 else s.X
    def virt(s): return (s.c.x0 + s.r, s.c.y0 - s.s) if s.phase == 0 else (s.X, s.Y)
    def book(s, sp):
        for k in ('plat', 'fdr', 'hld', 'bb'):
            s.pend[k] += sp[k]; s.earned[k] += sp[k]
        s.earned['liq'] += sp['liq']; s.fees_total += sp['fee']
        drip = 0
        if s.phase == 1:
            drip = min(s.L, sp['liq_floor'])               # never the rounding remainder
            s.X += sp['liq'] + drip; s.L -= drip; s.out['liq_added'] += sp['liq'] + drip
        else:
            s.L += sp['liq']
        return drip
    def max_quote_in(s):
        assert s.phase == 0
        return max(MIN_TRADE, gross_for(s.c, s.c.R - s.r))
    def quote_buy(s, G):
        c = s.c
        if G < MIN_TRADE: raise ValueError('TradeTooSmall')
        n = G - G * c.t // D
        if s.phase == 0:
            rem = c.R - s.r
            assert rem >= 1                                 # V5b: r <= f(S-1) <= R-1
            if n >= rem: s2, cc, grad = c.S, rem, True
            else:
                s2 = c.tokens_for(s.r + n); cc = c.f(s2) - s.r; grad = False
                assert cc == n                              # Lemma C3: no dust
            charged = G if cc == n else gross_for(c, cc)
            tok = s2 - s.s
        else:
            chk(s.Y * n)
            cc, charged, tok, grad, s2 = n, G, (s.Y * n) // (s.X + n), False, None
        sp = split(c, charged)
        assert charged - sp['fee'] == cc and charged <= G and cc >= 1
        return dict(charged=charged, net=cc, tokens=tok, grad=grad, s2=s2, partial=charged < G, **sp)
    def buy(s, G, minout=0):
        q = s.quote_buy(G)
        if q['tokens'] < 1: raise ValueError('ZeroOutput')
        if q['tokens'] < minout: raise ValueError('Slippage')
        c = s.c
        if s.phase == 0:
            s.s = q['s2']; s.r += q['net']; assert s.r == c.f(s.s)
        else:
            k0 = s.X * s.Y
            s.X += q['net']; s.Y -= q['tokens']; assert s.Y >= 1 and s.X * s.Y >= k0
        s.vault -= q['tokens']; s.lam += q['charged']
        q['drip'] = s.book(q)
        if q['grad']:
            assert s.s == c.S and s.r == c.R
            s.phase = 1; s.X = c.R; s.Y = c.P
            assert s.vault == c.P
        return q
    def quote_sell(s, t):
        c = s.c
        if t < 1: raise ValueError('ZeroAmount')
        if s.phase == 0:
            if t > s.s: raise ValueError('SellExceedsCurve')
            s2 = s.s - t; gross = s.r - c.f(s2)
        else:
            chk(s.X * t); s2 = None; gross = (s.X * t) // (s.Y + t)
        sp = split(c, gross); out = gross - sp['fee']
        return dict(gross=gross, out=out, s2=s2, **sp)
    def sell(s, t, minout=0):
        q = s.quote_sell(t)
        if q['out'] < 1: raise ValueError('ZeroOutput')
        if q['out'] < minout: raise ValueError('Slippage')
        c = s.c
        if s.phase == 0:
            s.s = q['s2']; s.r = c.f(s.s)
        else:
            k0 = s.X * s.Y
            s.X -= q['gross']; s.Y += t; assert s.X >= 1 and s.X * s.Y >= k0
        s.vault += t; s.lam -= q['out']
        q['drip'] = s.book(q)
        return q
    def cap(s):
        chk(s.depth() * s.c.t)
        return s.depth() * s.c.t // (CAP_DIV * D)
    def buyback(s):
        c = s.c
        if s.pend['bb'] == 0 or s.slot < s.last_bb + INTERVAL: return None
        cap = s.cap()
        b = min(s.pend['bb'], cap)
        if b == 0: return None
        if s.phase == 0:
            s2 = min(c.tokens_for(s.r + b), c.S - 1)
            spent = c.f(s2) - s.r; coins = s2 - s.s
            if coins == 0 or spent == 0: return None
            s.s = s2; s.r = c.f(s2)
        else:
            chk(s.Y * b)
            coins = (s.Y * b) // (s.X + b); spent = b
            if coins == 0: return None
            k0 = s.X * s.Y; s.X += b; s.Y -= coins; assert s.X * s.Y >= k0
        assert spent <= b <= s.pend['bb']
        s.pend['bb'] -= spent; s.out['bb'] += spent; s.burned += coins
        s.vault -= coins; s.supply -= coins; s.last_bb = s.slot
        return dict(spent=spent, coins=coins, cap=cap)
    def pay(s, k):
        a = s.pend[k]; s.pend[k] = 0; s.out[k] += a; s.lam -= a; return a
    def check(s):
        c = s.c
        assert s.lam == s.reserve() + s.L + sum(s.pend.values())
        if s.phase == 0:
            assert s.r == c.f(s.s) and 0 <= s.s < c.S and s.r <= c.R - 1 and s.X == 0 and s.Y == 0
            assert s.vault == c.S - s.s + c.P
        else:
            assert s.vault == s.Y and s.X >= 1 and s.Y >= 1 and s.s == c.S
        assert s.supply == SUPPLY - c.dust - s.burned
        for k in ('plat', 'fdr', 'hld', 'bb'):
            assert s.pend[k] == s.earned[k] - s.out[k]
        assert s.L == s.earned['liq'] - s.out['liq_added']
        assert s.fees_total == sum(s.earned.values())
        for v in (s.s, s.r, s.X, s.Y, s.L, s.lam, *s.pend.values()):
            assert 0 <= v <= U64

S = 793_099_990_000_000
P = 206_900_000_900_000                    # R8: 206,900,000.9 coins; 9.1 coins burned at launch
R = 85_000_000_000
DEFAULT = Cfg(30_000_853_639, 1_073_025_598_486_615, S, P, R)

# derive_curve of VICINITY-CURVE-DESIGN.md 5.9 and 5.16, on top of model.py.
#
# The continuous design gives x0* = R*P/(S - P) and y0* = S^2/(S - P). The
# integer search takes every x0 within `radius` of x0* and, for each, the
# largest d = y0 - S that satisfies
#   (1) exact completion  ceil(x0*S/R) <= d <= floor((x0*S - 1)/(R - 1)),
#   (2) one-sided continuity  R*d <= (x0 + R)*P  (the pool never opens above),
#   (3) V5b f(S - 1) <= R - 1, V6 x0*y0 <= d^2, x0 <= 2^60, y0 <= 2^60 and
#       V7's 1-part-per-billion tolerance,
# and keeps the x0 with the smallest continuity gap (x0 + R)*P - R*d (the first,
# that is the smallest x0, on a tie). The Rust crate implements the same search.
from model import cdiv

RADIUS = 20_000


def derive_curve(S, P, R, radius=RADIUS):
    """(x0, y0) or None when no admissible integers exist."""
    if not (S > P >= 1 and R >= 2):
        return None
    num, den = R * P, S - P
    q, rm = divmod(num, den)
    lo = q - radius if rm == 0 else q - radius + 1
    hi = q + radius
    best = None
    for x0 in range(max(1, lo), hi + 1):
        a = x0 * S
        d = min((a - 1) // (R - 1), (x0 + R) * P // R)
        if d < cdiv(a, R):
            continue
        if cdiv(x0 * (S - 1), d + 1) > R - 1:
            continue
        if x0 * (S + d) > d * d:
            continue
        if x0 > 2**60 or S + d > 2**60:
            continue
        gap = (x0 + R) * P - R * d
        if gap > (x0 + R) * P // 10**9:
            continue
        if best is None or gap < best[0]:
            best = (gap, x0, S + d)
    return None if best is None else (best[1], best[2])

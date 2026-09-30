/**
 * The rules of Vicinity, in one place, with a version number. Every founder seat, election and
 * snapshot stores the version it was decided under, and the site shows it. Changing a rule means
 * a new version here (and a public commit), never a silent edit: people keep the rules they joined under.
 *
 * Why these rules (see /rules on the site):
 *   - Leadership is earned over time, not bought in a minute: founders must HOLD for 7 days before
 *     applying, balances are sampled at unpredictable times, and big bags only count up to 2× the minimum.
 *   - The stake fits the city: a 100K–1M ladder scaled by population ("rule of eight": 8× the people,
 *     2× the stake), so small towns aren't priced out and big cities aren't cheap to capture.
 *   - No empty elections: a lone qualified claimer founds at once as a Seed Steward (90-day bonded
 *     probation, challengeable by locals), instead of sitting through a 72-hour election of one.
 *   - Friends can found together: 3–5 verified locals may pool seasoned holdings as a squad.
 *   - No squatting: a founder who drops below the line gets 7 days to fix it (stewards get 48 hours),
 *     then the seat reopens; a city dark for 30 days can be steward-founded by any holder.
 *   - No single-person power: hides expire after 24 h unless a second moderator (or the community)
 *     confirms; bans need two people; everything is logged publicly and can be appealed.
 *   - Country managers are elected for 90 days (votes count most), not handed to the richest wallet.
 */
export const POLICY = {
  version: 5,
  effectiveAt: "2026-10-01", // v5: Stake Ladder (tiered founder stake) + Seed Steward + Squad Founding

  founder: {
    // v5: the Stake Ladder. One rule for every city, scaled by people:
    //   stake = 100K × (population / 10K)^(1/3), clamped to [100K, 1M],
    //   rounded DOWN to the nearest 10K (balance history tracks every 10K rung).
    // "Rule of eight": every 8× in population doubles the requirement.
    //   10K people → 100K · 80K → 200K · 640K → 400K · 5.12M → 800K · 10M+ → 1M.
    // The amount is set when someone claims a city, from the population on file then.
    // Founders keep the threshold they claimed under even if the ladder moves later
    // (grandfathered); populations refresh quarterly and new claims use the new numbers.
    // Decided 2026-09-30: 1B total supply; stake tiered 100K–1M by city size (supersedes the flat 1M).
    ladder: { base: 100_000, max: 1_000_000, refPop: 10_000, rung: 10_000 },
    qualifyingDays: 7,         // held the amount in every balance sample for 7 days before applying
    localDays: 7,              // home community set at least 7 days before applying
    windowHours: 72,           // applications open a 72-hour window for that city
    appealHours: 48,           // then 48 hours for locals to object before the seat is final
    graceDays: 7,              // below the amount → 7 days to fix it (moderation paused meanwhile)
    maxGraces: 2,              // more than 2 grace periods in 90 days → the seat is released
    graceWindowDays: 90,
    cooldownDays: 30,          // a released or revoked founder waits 30 days to apply again
    // v5: Seed Steward. A lone qualified claimer skips the election-of-one and founds at once,
    // provisionally: the stake is bonded for a 90-day probation. Confirmed automatically at
    // 90 days or 50 verified local members, whichever comes first. A challenger needs 10
    // verified local endorsements to force an election, which the steward can run in.
    // Below the amount → 48 hours to fix it (not 7 days). A city dark for 30 days can be
    // steward-founded by any holder; a verified local always has priority to challenge.
    stewardProbationDays: 90,
    stewardQuorum: 50,            // verified local members confirm the steward early
    stewardChallengeEndorsements: 10,
    stewardGraceHours: 48,        // bonded stake: 48 hours to fix a dip
    darkCityDays: 30,
    // v5: Squad Founding. 3–5 verified locals pool holdings to meet the bar: the same 7-day
    // tenure rule applies to every member's share. One designated founder wallet mints;
    // everyone is recorded as a co-founder.
    squadMin: 3,
    squadMax: 5,
    weights: { endorsement: 0.5, contribution: 0.3, stake: 0.2 },
    stakeCap: 2,               // holdings above 2× the amount don't count
  },

  voters: { minAccountDays: 7, minHomeDays: 7, needsCheckin: true }, // who may endorse founders and elect managers

  manager: {
    termDays: 90,
    electionDays: 7,
    minFounderDays: 30,        // candidates: founders active for 30+ days
    maxConsecutiveTerms: 2,    // then sit out one term
    weights: { vote: 0.5, service: 0.3, stake: 0.2 },
  },

  moderation: {
    reasons: ["spam", "scam", "abuse", "illegal", "off_topic", "other"],
    hideHours: 24,             // a single moderator's hide lasts 24 h unless confirmed
    reportsToConfirm: 3,       // ...or 3 people reported it
    reportsToAutoHide: 5,      // 5 reports hide a post until a moderator reviews it
    banDays: 30,               // bans are temporary and need two different people
    proposalHours: 72,         // an unapproved ban proposal expires
  },

  supporters: { averageDays: 14, challengeHours: 48, minAmount: 1 },

  // City coins: the active City Founder designs the city's one official coin. The ticker is the city's own
  // (fixed by the map). Raydium LaunchLab pairs a coin with SOL, USDC or RAY. The design locks once launched.
  coins: { pairs: ["SOL", "USDC", "RAY"], colors: ["gold", "rose", "ocean", "emerald", "violet", "ink"], nameMax: 32, pitchMax: 200, editsPerDay: 20 },

  sampling: { cronMinutes: 10, meanMinutes: 60, minGapMinutes: 5, maxGapMinutes: 180 },
  attestation: { minutes: 5 },
  freshProofMinutes: 30,       // sensitive actions need the wallet proven again within 30 minutes
  limits: { locatePerHour: 20, reportsPerDay: 30 },

  // Things nobody can ever do, by design. Shown on /rules.
  never: [
    "Move, freeze or take anyone's tokens.",
    "Mint more $VICINITY: minting is switched off on the blockchain.",
    "Change a city's official coin once it has launched.",
    "Change these rules silently: every change is a new version, published first.",
    "Ban someone on one person's word: bans need two people and can be appealed.",
    "See or store anyone's exact location.",
  ],
};

/** Tokens a founder of this city must hold: 100K × (pop/10K)^(1/3), clamped [100K, 1M], floored to 10K. */
export function founderAmount(pop = 0) {
  const l = POLICY.founder.ladder;
  const raw = l.base * Math.cbrt(Math.max(pop || 0, 1) / l.refPop);
  return Math.floor(Math.min(l.max, Math.max(l.base, raw)) / l.rung) * l.rung;
}
/** Every rung of the ladder (balance history tracks how long each wallet has held each of them).
 *  Starts at one rung (10K), not the base (100K): squad members prove tenure on their
 *  rung-floored contributions, which can be smaller than a full founder bar. */
export const founderLevels = () => {
  const l = POLICY.founder.ladder, out = [];
  for (let a = l.rung; a <= l.max; a += l.rung) out.push(a);
  return out;
};

export const HOUR = 3600_000, DAY = 86400_000;
export const iso = (ms) => new Date(ms).toISOString();

/** The policy as the public sees it (GET /api/policy). */
export const publicPolicy = () => POLICY;

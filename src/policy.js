/**
 * The rules of Vicinity, in one place, with a version number. Every founder seat, election and
 * snapshot stores the version it was decided under, and the site shows it. Changing a rule means
 * a new version here (and a public commit), never a silent edit: people keep the rules they joined under.
 *
 * Why these rules (see /rules on the site):
 *   - Leadership is earned over time, not bought in a minute: founders must HOLD for 14 days before
 *     applying, balances are sampled at unpredictable times, and big bags only count up to 2× the minimum.
 *   - No races: a city's founder is chosen after a 72-hour application window, mostly by verified locals.
 *   - No squatting: a founder who drops below the line gets 7 days to fix it, then the seat reopens.
 *   - No single-person power: hides expire after 24 h unless a second moderator (or the community)
 *     confirms; bans need two people; everything is logged publicly and can be appealed.
 *   - Country managers are elected for 90 days (votes count most), not handed to the richest wallet.
 */
export const POLICY = {
  version: 3,
  effectiveAt: "2026-09-27", // v3: City Founders design their city's coin

  founder: {
    // Tokens a founder must hold. Tiers let bigger cities ask for more; one tier = the same for every city.
    // PRODUCT DECISION PENDING: 1B total supply ÷ 1,000,000 = at most 1,000 founder seats ever.
    tiers: [{ minPopulation: 0, amount: 1_000_000 }],
    qualifyingDays: 14,        // held the amount in every balance sample for 14 days before applying
    localDays: 7,              // home community set at least 7 days before applying
    windowHours: 72,           // the first application opens a 72-hour window for that city
    appealHours: 48,           // then 48 hours for locals to object before the seat is final
    graceDays: 7,              // below the amount → 7 days to fix it (moderation paused meanwhile)
    maxGraces: 2,              // more than 2 grace periods in 90 days → the seat is released
    graceWindowDays: 90,
    cooldownDays: 30,          // a released or revoked founder waits 30 days to apply again
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

/** Tokens a founder of this city must hold (the highest tier whose population the city reaches). */
export function founderAmount(pop = 0) {
  let amount = POLICY.founder.tiers[0].amount;
  for (const t of POLICY.founder.tiers) if ((pop || 0) >= t.minPopulation) amount = t.amount;
  return amount;
}
/** Every distinct founder amount (balance history tracks how long each wallet has held each of them). */
export const founderLevels = () => [...new Set(POLICY.founder.tiers.map((t) => t.amount))];

export const HOUR = 3600_000, DAY = 86400_000;
export const iso = (ms) => new Date(ms).toISOString();

/** The policy as the public sees it (GET /api/policy). */
export const publicPolicy = () => POLICY;

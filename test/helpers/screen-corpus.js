// Evasion corpora for the description screener's tests (test/screen-wordlist.test.js): generated the way the verification's generator
// made them (plain characters only), and the hand-written probes of its findings (SEC-1-R2, SCAM-1, SEC-2-R2-links, SEC-2-R2-handles;
// round 5: SCR-NAME-1, SCR-PLAIN-1, SCR-SCAM-1, SCR-LINK-1). Every string here must be flagged or refused, never passed; and where a
// check can say why, it must (a founder's own words are flagged "review" anyway: the checks only tell the reviewer what to look at).

/** Slurs to respell (the plain-letter generator works on these). */
export const SLUR_BASES = ["nigger", "nigga", "faggot", "tranny", "kike", "spic", "wetback", "beaner", "chinky", "gook", "raghead", "towelhead",
  "jigaboo", "darkie", "retarded", "mongoloid", "shemale", "poofter", "golliwog", "pajeet", "zipperhead", "coolie", "kaffir", "dago", "gyppo", "paki",
  "polack", "injun", "wop", "jap"];
const VOWELS = /[aeiou]/;
/** Every plain-letter respelling of one slur: q for g, ph for f, letters doubled or tripled or left out, plurals, endings, separators. */
export function respell(w) {
  const out = new Set();
  const add = (x) => { if (x && x !== w) out.add(x); };
  add(w.replace(/g/g, "q"));
  add(w.replace(/g/, "q"));
  add(w.replace(/f/g, "ph"));
  for (let i = 0; i < w.length; i++) {
    add(w.slice(0, i) + w[i] + w.slice(i)); // a letter doubled
    add(w.slice(0, i) + w[i] + w[i] + w.slice(i)); // tripled
    if (VOWELS.test(w[i]) || (i > 0 && w[i] === w[i - 1])) add(w.slice(0, i) + w.slice(i + 1)); // a vowel or a doubled letter left out
  }
  for (const end of ["s", "z", "zz", "es", "lover", "lovers", "boy", "boys", "ish", "s123", "z4life"]) add(w + end);
  if (/y$/.test(w)) add(`${w.slice(0, -1)}ies`);
  for (const sep of [",", ";", ":", "?", "&", "%", ".", "-", "_", ", ", " ; "]) add([...w].join(sep));
  add(`${w.slice(0, 2)}\n${w.slice(2)}s`);
  add(w.toUpperCase());
  add(w[0].toUpperCase() + w.slice(1) + "s");
  return [...out];
}
/**
 * The generated corpus: every respelling of every base in a sentence, and again written as a name (a capital, then small letters) in a
 * sentence of everyday English (where a name used to pass by itself, before SCR-NAME-1): about 2,000 [respelling, text] pairs.
 */
export function slurCorpus() {
  const out = [];
  const frames = [(x) => `Utica coin: no ${x} here.`, (x) => `Our city welcomes everyone but ${x}.`];
  let f = 0;
  for (const b of SLUR_BASES) {
    for (const x of respell(b)) {
      out.push([x, frames[f++ % frames.length](x)]);
      if (/^[a-z]+$/i.test(x)) out.push([x, `Our lovely city welcomes everyone but the ${x[0].toUpperCase()}${x.slice(1).toLowerCase()} from the old mill.`]);
    }
  }
  return out;
}
/** Slurs no list named before this round, other languages' slurs, and hate written without a slur (SEC-1-R2). */
export const UNLISTED_AND_HATE = [
  "Utica has pajeets and towel heads", "Utica: no zipper heads, no christ killers", "Utica is no place for wogs", "Utica says no to troons",
  "nignogs are not welcome in Utica", "jungle bunnies stay out of Utica", "golliwogs go home from Utica", "Utica: ching chong go away",
  "Utica coin: Juden raus, keine Kanaken.", "Utica: Neger und Kanaken raus", "Utica sin sudacas ni maricones", "Utica sans bougnoules ni youpins",
  "Utica senza froci", "Utica bez pedałami", "Utica: no niqqers or trannies here.", "Utica for sand monkeys? never",
  "Juden raus from Utica", "gas the Jews of Utica", "No Jews allowed in Utica", "1488 forever in Utica", "Utica 14 88 always",
  "lynch them all in Utica", "hang every Mexican in Utica", "gays should be stoned in Utica", "Muslims out of Utica now",
  "Kill all immigrants in Utica", "Deport every migrant from Utica", "White power Utica forever", "Utica says heil Hitler",
  "Blacks not welcome in Utica", "Burn the mosques of Utica", "Utica for whites only, no blacks", "Refugees are vermin in Utica",
  "Utica: the great replacement is real", "Utica, blood and soil", "Send them back from Utica", "Utica gays go home",
];
/** Scams in ordinary words (SCAM-1): every probe of the finding, and more of each kind. */
export const SCAM_PROBES = [
  "Connect your wallet at mvmoon.sbs to claim free Utica tokens.", "Send 1 SOL to the founder and get 2 SOL back within an hour.",
  "Enter your seed phrase on the Utica page to verify your wallet.", "Validate your wallet to receive the Utica bonus.",
  "Holders earn 20% every week just for holding Utica.", "Stake Utica for 300 percent yearly yield.", "Utica is approved by the SEC and fully insured.",
  "Endorsed by Elon Musk himself. Utica to one dollar.", "This coin doubles your money in a month.", "Only 50 spots left in the Utica whitelist.",
  "Utica: guaranteeed returns for all holders.", "Utica: guarranteed profit every day.", "Send 2 SOL and receive 4 SOL back from Utica.",
  "Share your recovery phrase with Utica support to unlock rewards.", "Type your private key into the Utica form.",
  "Sync your wallet with Utica to get the airdrop.", "Claim your free Utica tokens now.", "Utica pays 5% daily to every holder.",
  "Utica holders get weekly payouts.", "Utica will hit $1 by Christmas.", "Utica goes to 10 dollars soon.", "Utica is backed by gold and real estate.",
  "Utica is regulated and licensed in New York.", "Utica is insured by the FDIC.", "Approved by the FCA and the CFTC, Utica is safe.",
  "Endorsed by Taylor Swift, Utica is the coin.", "Vitalik bought Utica.", "Utica: your money back if it drops.", "Hurry, Utica whitelist closes soon.",
  "Utica: 10 times your money in a week.", "Utica staking pays 12% a month.", "Utica gives 2x back on every deposit, get double back.",
  "Utica sends rewards to holders every week, 3% each time.", "Utica: the next coin to make you a millionaire.", "Join the Utica presale today.",
  "Approve the transaction to receive Utica.", "Utica airdrop: connect wallet and claim.",
];
/** Names a link or a handle is made of: none of them a word the screener knows. */
const LINK_NAMES = ["mvmoon", "uticacoin", "moonutica", "utica22", "gemutica"];
const LINK_TLDS = ["com", "net", "org", "io", "co", "app", "xyz", "sbs", "cfd", "icu", "lol", "rocks", "wtf", "army", "zone", "wiki", "one", "bio", "ink",
  "buzz", "ninja", "pics", "mom", "fun", "site", "online", "info", "live", "me", "to", "tv", "gg"];
const LINK_SEPS = [".", " ", ",", "-", " , ", " - ", " dot ", " period ", " punto ", "(.)", "[.]"];
const LINK_FRAMES = [(x) => `Visit ${x} today`, (x) => `Utica news at ${x} daily`, (x) => `${x} for the Utica news`, (x) => `Go to ${x} now`];
/** The generated link corpus (SEC-2-R2-links): about 1,800 spellings, and the finding's own. */
export function linkCorpus() {
  const out = [];
  let f = 0;
  for (const n of LINK_NAMES) for (const t of LINK_TLDS) for (const sep of LINK_SEPS) out.push(LINK_FRAMES[f++ % LINK_FRAMES.length](`${n}${sep}${t}`));
  out.push("Visit mvmoon net", "mvmoon co is home", "Find mvmoon app now", "mvmoon,com for Utica", "Utica at mvmoon-io", "mvmoon , com is home",
    "mvmoon - org is home", "mvmoon period net is home", "mvmoon punto net is home", "Utica: lnktr ee mvmoon", "Utica: discordgg mvmoon", "Join t-me mvmoon",
    "Join t,me mvmoon", "Visit moon net today", "Visit pizza app now", "Go to pizza site today", "Follow x com/uticacoin", "Join t me/uticacoin",
    "bit ly/utica22 for news", "uticacoin com/buy now", "Visit mvmoon.sbs today", "See mvmoon.cfd for news", "Utica on mvmoon.icu", "Utica at mvmoon.lol",
    "Utica at uticacoin.rocks", "Utica at uticacoin.wtf", "Utica at mvmoon.army", "Utica at mvmoon.zone", "Utica at mvmoon.wiki", "Utica at mvmoon.one",
    "Utica at mvmoon.bio", "Utica at mvmoon.ink", "Utica at mvmoon.buzz", "Utica at mvmoon.ninja", "Utica at mvmoon.pics", "Utica at mvmoon.mom",
    "Utica at mvmoon.xyzw", "Utica at moon.notatld");
  return out;
}
const PLATFORMS = ["telegram", "discord", "instagram", "twitter", "tiktok", "reddit", "youtube", "facebook", "snapchat", "whatsapp", "linktree"];
/** A platform's name misspelled the ways the generator did: i for l and l for i, one letter left out or doubled, capital I for l. */
function misspell(p) {
  const out = new Set([p.replace(/l/g, "I"), p.replace(/i/g, "l"), p.replace(/l/g, "1"), p.replace(/o/g, "0")]);
  for (let i = 1; i < p.length - 1; i++) { out.add(p.slice(0, i) + p.slice(i + 1)); out.add(p.slice(0, i) + p[i] + p.slice(i)); }
  for (let i = 2; i < p.length - 1; i++) out.add(`${p.slice(0, i)} ${p.slice(i)}`);
  out.delete(p);
  return [...out];
}
/** The handle corpus (SEC-2-R2-handles): every misspelling and split of the platforms, short names after a contact word, mail, chats. */
export function handleCorpus() {
  const out = [];
  const frames = [(p) => `Join our ${p}: mvmoon`, (p) => `Utica news on ${p} daily`, (p) => `Follow ${p} uticamoonboys`];
  let f = 0;
  for (const p of PLATFORMS) for (const m of misspell(p)) out.push(frames[f++ % frames.length](m));
  out.push("Join our teIegram: mvmoon", "Utica on dlscord", "Our lnstagram is mvmoon", "Utica on twltter", "Utica on tlktok", "Utica on reddlt",
    "Utica on tele gram", "Utica on tik tok", "Utica on you tube", "Utica on face book", "Utica on snap chat", "Utica on whats app", "Utica on telegrm",
    "Join our TG group mvmoon", "Our IG is mvmoon", "Follow mvmoon on the gram", "Add mvmoon on snap", "Email mvmoon at gmail for details",
    "Follow uticamoonboys for news", "Message mvmoon for a deal", "Utica fans meet on our server", "Join the Utica group chat", "Utica: write to mvmoon at outlook",
    "Utica: mvmoon at proton", "Find Utica on the tele", "Join our channel for Utica news", "Utica on insta gram", "Follow the Utica fb page",
    "Our yt has Utica videos", "Utica moonboys on x", "Find uticamoonboys in the gc", "Ask moonboys on our discord server");
  return out;
}

/* ---------------------------------------------------------------- review round 5 */
/** The sound substitutions of the verification's generator (SCR-NAME-1): gg to kk, cc or ck, g to k or c, i to y, e or ee, er to a, ah, uh, ur or ar... */
const SOUND_RULES = [["gg", "kk"], ["gg", "cc"], ["gg", "ck"], ["g", "k"], ["g", "c"], ["i", "y"], ["i", "e"], ["i", "ee"], ["er", "a"], ["er", "ah"], ["er", "uh"],
  ["er", "ur"], ["er", "ar"], ["a", "ah"], ["a", "er"], ["f", "v"], ["k", "c"], ["c", "k"], ["ck", "k"], ["ea", "eer"], ["e", "ee"], ["o", "oh"], ["oo", "u"], ["s", "z"],
  ["y", "ie"]];
/** Every spelling one sound substitution away from `w` (each rule at each place it applies). */
export function soundSubstitutions(w) {
  const out = new Set();
  for (const [a, b] of SOUND_RULES) for (let i = w.indexOf(a); i >= 0; i = w.indexOf(a, i + 1)) out.add(w.slice(0, i) + b + w.slice(i + a.length));
  out.delete(w);
  return [...out];
}
/** The frames the verification wrote each spelling in: as a name, in everyday English. */
export const NAME_FRAMES = [(x) => `Our lovely city of Utica welcomes everyone but the ${x} from the mill.`, (x) => `Every weekend the ${x} family hosts a picnic by the river in Utica.`];
/**
 * SCR-NAME-1's generator: one or two sound substitutions of every one-word entry of `bases` (SLURS and FOREIGN_SLURS), written as a
 * name (a capital, then small letters) in the two frames, one frame each in turn: [spelling, text] pairs (about 6,500).
 */
export function soundCorpus(bases) {
  const spellings = new Set();
  for (const b of bases.filter((e) => /^[a-z]+$/.test(e))) for (const x of soundSubstitutions(b)) { spellings.add(x); for (const y of soundSubstitutions(x)) spellings.add(y); }
  let f = 0;
  return [...spellings].map((w) => { const name = w[0].toUpperCase() + w.slice(1); return [name, NAME_FRAMES[f++ % NAME_FRAMES.length](name)]; });
}
/** The spellings of SCR-NAME-1's examples (each in the first frame): Nikkas, Nicca, Nygga... */
export const NAME_EXAMPLES = ["Nikkas", "Nicca", "Nygga", "Negga", "Nigka", "Niggarh", "Niggurh", "Fagkot", "Fagcot", "Kiker", "Jiggerboo", "Towelheerd", "Zipperheerd"];
/**
 * Hate, threats and crime written in dictionary words (SCR-PLAIN-1): no check can tell these from an honest sentence, so they are never
 * used by themselves; a person reads every founder's description.
 */
export const PLAIN_PROBES = [
  // hate without a slur
  "Jews control the banks in Utica.", "The Holocaust never happened in Utica.", "Keep Utica white and proud.", "Muslims are terrorists, all of them.",
  "Trans people are mentally ill.", "Utica will be the first city of the new reich.", "Utica eighty eight forever",
  // slurs that are dictionary words, used as slurs
  "No nips allowed in Utica.", "Keep the spades out of Utica.", "Utica has too many knee grows.", "The founder of the Syracuse coin is a dirty shylock.",
  // threats, sex and crime
  "Kill the mayor of Utica.", "Sellers will be shot.", "Teen girls of Utica want to chat.", "Buy cocaine with Utica coin.",
];
/** Drainers, scams and price promises in ordinary words (SCR-SCAM-1), with the reason each must carry. */
export const SCAM_WORD_PROBES = [
  ["Holders collect a bonus at moon dot city, just sign the message.", "wallet_ask"],
  ["Collect your free share at moon dot city today, sign in with your wallet.", "wallet_ask"],
  ["Get your gift at utica moon dot money: log in with your wallet and approve.", "wallet_ask"],
  ["Give us one coin and we give you two.", "wallet_ask"],
  ["Send any amount to the founder and receive double.", "wallet_ask"],
  ["Your coins are frozen, unfreeze them on our page.", "wallet_ask"],
  ["Pay the unlock fee to get your bonus.", "wallet_ask"],
  ["Lend us your coins and we pay you back double.", "wallet_ask"],
  ["Gas fees are covered, just approve the transaction in your wallet.", "wallet_ask"],
  ["This coin will make you rich.", "financial"],
  ["Price only goes up from here.", "financial"],
  ["You will never lose money with Utica coin.", "financial"],
  ["Ten fold return by spring.", "financial"],
  ["Holders get paid every Sunday.", "financial"],
  ["Utica will make every holder a millionaire.", "financial"],
  ["Ten times your money by summer with Utica.", "financial"],
  ["The value of Utica will double soon.", "financial"],
];
/** Links, contacts and handles written in words, and official claims (SCR-LINK-1), with the reason each must carry. */
export const LINK_WORD_PROBES = [
  ["Find us at moon dot city", "link_like"], ["Our website is good dot money", "link_like"], ["See moon point life", "link_like"],
  ["Visit moon dot c o m", "link_like"], ["double u double u double u dot moon dot city", "link_like"],
  ["Get the app at moon dot city slash app.", "link_like"], ["Email hello at moon dot city.", "contact"],
  ["Call three one five five five five zero one two three.", "contact"], ["Text us on 315 five five five 0123 today.", "contact"],
  ["Our handle is utica underscore coin.", "link_like"], ["Search for Utica Moon on the bird site.", "link_like"],
  ["Watch us on the clock app every day.", "link_like"], ["The Utica police department supports this coin.", "brand"],
  ["Vicinity says this is the safest coin.", "staff"], ["The White House holds Utica coin.", "brand"], ["The mayor picked Utica coin.", "brand"],
  ["The president stands behind Utica coin.", "brand"],
];

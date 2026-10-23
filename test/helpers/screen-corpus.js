// Evasion corpora for the description screener's tests (test/screen-wordlist.test.js): generated the way the verification's generator
// made them (plain characters only), and the hand-written probes of its findings (SEC-1-R2, SCAM-1, SEC-2-R2-links, SEC-2-R2-handles).
// Every string here must be flagged or refused, never passed.

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
 * sentence of everyday English, where a name may pass (src/screen.js allowedNames): about 2,000 [respelling, text] pairs.
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

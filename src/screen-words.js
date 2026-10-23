/**
 * The word lists of the description screener (src/screen.js). Plain arrays, for the owner to review (decision D10: slurs BLOCK, every
 * other list only FLAGS, so a person looks before anything is refused for good). Changing any list changes src/screen.js RULES_VERSION,
 * and a founder description that passed under older lists is screened again before it can launch.
 *
 * The lists are the LAST of four checks, not the first: a description passes by itself only when (a) every character is a plain one
 * (src/screen.js plainChars: the letters of the city's own script and A to Z, the digits 0 to 9, everyday punctuation and spaces), (b)
 * every word is one the screener knows (src/screen.js knownWords: everyday English from src/screen-vocab.js, the names of the places in
 * the Vicinity city list, the city's own words and the words at the end of this file), (c) nothing in it looks like a link, an address
 * or a handle (linkLike, with the allow-list words at the end of this file), and (d) none of the lists below finds anything. Fancy-text
 * styles, other alphabets, other languages, new spellings and words nobody listed are therefore never matched against a list at all:
 * they are flagged for a person whatever they spell (and a word that is a listed slur spelled another way is refused).
 *
 * Every entry is written in plain lower-case letters. The screener compares them with the text after folding it: Unicode compatibility
 * forms, letter case, accents, look-alike letters from other scripts, leetspeak (0 o, 1 i, 3 e, 4 a, 5 s, 7 t, @ a, $ s), dots, dashes,
 * commas and spaces between single letters ("s.c.a.m", "s,c,a,m", "s c a m"). Single words match whole words only (so "Scunthorpe",
 * "Essex" or "Penistone" never match a shorter word inside them), with or without a plural ("s", "es", "ies"); an entry with a space
 * matches that run of words. A city's own name, region, country and ticker never count against it.
 */

/** Slurs: hateful names for people because of their race, ethnicity, religion, sexuality, gender identity or disability. BLOCK. */
export const SLURS = Object.freeze([
  "nigger", "nigga", "niggah", "nigguh", "niggaz", "jigaboo", "jiggaboo", "porchmonkey", "porch monkey", "darkie",
  "kike", "kyke", "heeb", "hymie", "christkiller",
  "spic", "wetback", "beaner",
  "chinky", "gook", "zipperhead", "slant eye", "slanteye", "jap",
  "paki", "raghead", "towelhead", "sandnigger", "camel jockey", "cameljockey",
  "gypo", "gyppo", "pikey", "wop", "dago", "polack", "injun", "boong", "kaffir", "kafir", "coolie",
  "faggot", "faggots", "fagg", "poofter", "poof", "tranny", "shemale", "batty boy", "battyboy",
  "retarded", "mongoloid", "spaz",
  // the review's second round (SEC-1-R2): slurs that were missing
  "pajeet", "towel head", "zipper head", "christ killer", "jungle bunny", "nignog", "nig nog", "wog", "golliwog", "ching chong", "niglet",
  "sand monkey", "mud people", "spear chucker", "curry muncher", "border hopper", "fence hopper", "dot head", "dune coon",
]);

/**
 * Insults, threats and sexual words, and the words that are slurs in some uses but ordinary words in others ("chink in the armour",
 * French "retard", the martial art "sambo", place names). FLAG: a person reviews it if the founder sends it for review.
 */
export const ABUSE = Object.freeze([
  "fuck", "fucking", "fucker", "motherfucker", "fuk", "fck", "shit", "shitty", "bullshit", "bitch", "bastard", "asshole", "arsehole", "dick", "dickhead",
  "cock", "cunt", "twat", "wanker", "prick", "pussy", "slut", "whore", "skank", "douche", "douchebag", "jackass", "dumbass", "scumbag",
  "idiot", "moron", "imbecile", "loser", "stupid", "subhuman", "vermin", "scum", "filth",
  "porn", "porno", "nude", "nudes", "naked", "sex", "sexy", "boobs", "tits", "penis", "vagina", "dildo", "orgasm", "horny", "milf", "onlyfans",
  "rape", "rapist", "pedo", "pedophile", "paedophile",
  "nazi", "hitler", "kkk", "white power", "heil", "genocide",
  "kill yourself", "kys", "go die", "death to", "should die", "must die", "hang them", "shoot them", "burn them", "kill them", "kill all",
  "chink", "coon", "sambo", "spook", "negroid", "squaw", "redskin", "kraut", "yid", "fag", "dyke", "homo", "sodomite", "retard", "spastic",
  "cripple", "gyp", "gypped",
  // slurs in some uses that are also a word, a place or a name ("spick and span", "Troon", "Rio Negro"); a person decides
  "spick", "honky", "negro", "negress", "troon", "tar baby", "carpet muncher", "rug muncher", "fudge packer", "pillow biter", "wagon burner",
  "batty man", "chi chi man", "nancy boy", "street shitter", "mick", "paddy", "darky", "pickaninny", "mulatto", "half breed", "halfbreed", "sheeny", "chinaman", "injun", "dago", "wop",
  // hate written in ordinary words (SEC-1-R2): slogans, numbers and calls to violence; src/screen.js hateNear also reads a group of
  // people (GROUP_WORDS) next to a violent or excluding word (VIOLENCE_WORDS)
  "lynch", "lynched", "lynching", "lynchings", "raus", "juden raus", "auslander raus", "sieg heil", "heil hitler", "white pride", "white genocide",
  "whites only", "white only", "blacks only", "pure blood", "blood pure", "racial purity", "race mixing", "white race", "master race", "aryan", "aryans",
  "white nationalist", "white nationalism", "ethnostate", "remigration", "great replacement", "race war", "racial holy war", "rahowa", "blood and soil", "final solution", "day of the rope", "1488", "14 88", "14 words",
  "fourteen words", "zog", "gas the", "gas chamber", "jew down", "jewed", "send them back", "go back to africa", "go back to your country",
  "hang every", "hang all", "kill every", "shoot every", "burn every", "gas every", "should be stoned", "should be hanged", "should be shot",
  "should be killed", "should be gassed", "should be burned", "deserve to die", "not human",
]);

/**
 * Companies, exchanges, wallets, leagues, teams and Solana names a coin could pretend to be backed by. FLAG, only next to a word that
 * claims a tie (src/screen.js TIE_WORDS: official, partner, endorsed, sponsored, backed, by, with, ...).
 */
export const BRANDS = Object.freeze([
  "apple", "google", "alphabet", "microsoft", "amazon", "meta", "facebook", "instagram", "whatsapp", "tiktok", "twitter", "youtube", "netflix", "tesla",
  "spacex", "nvidia", "samsung", "sony", "nike", "adidas", "coca cola", "cocacola", "pepsi", "mcdonalds", "starbucks", "walmart", "disney", "uber",
  "airbnb", "visa", "mastercard", "paypal", "stripe", "jpmorgan", "goldman sachs", "blackrock", "fidelity", "vanguard",
  "binance", "coinbase", "kraken", "okx", "bybit", "kucoin", "bitget", "gemini", "robinhood", "crypto com", "ftx", "upbit", "bitfinex", "huobi", "htx",
  "phantom", "solflare", "backpack", "metamask", "ledger", "trezor", "trust wallet", "exodus",
  "solana", "solana foundation", "solana labs", "jupiter", "raydium", "orca", "meteora", "pump fun", "pumpfun", "magic eden", "tensor", "jito",
  "helius", "dexscreener", "birdeye", "coingecko", "coinmarketcap", "moonshot", "bonk", "wif", "ethereum", "bitcoin", "tether", "circle", "usdc",
  "nfl", "nba", "mlb", "nhl", "mls", "fifa", "uefa", "premier league", "la liga", "bundesliga", "serie a", "olympics", "ioc", "formula 1", "f1",
  "yankees", "red sox", "dodgers", "lakers", "celtics", "knicks", "warriors", "cowboys", "patriots", "packers", "manchester united", "man united",
  "manchester city", "man city", "liverpool fc", "chelsea fc", "arsenal fc", "real madrid", "barcelona fc", "fc barcelona", "bayern munich",
  "juventus", "psg", "ac milan", "inter milan", "ajax", "celtic fc", "rangers fc",
]);

/** Public bodies a coin could pretend to speak for. FLAG, only next to official, endorsed, approved, by, of, ... (src/screen.js). */
export const PUBLIC_BODIES = Object.freeze([
  "city council", "town council", "county council", "city hall", "town hall", "municipality", "government", "governor", "mayor", "mayors office",
  "police", "police department", "sheriff", "ministry", "parliament", "senate", "congress", "white house", "chamber of commerce",
  "tourism board", "embassy", "consulate", "united nations", "european union",
]);

/** Promises about price, profit or returns. FLAG. (Numbers like 100x and x100 are their own rule in src/screen.js.) */
export const FINANCIAL = Object.freeze([
  "guaranteed", "guarantee", "risk free", "riskfree", "no risk", "cant lose", "cannot lose", "can not lose", "profit", "profits", "profitable",
  "return on investment", "guaranteed returns", "high returns", "roi", "apy", "apr", "passive income", "dividend", "dividends", "invest",
  "investing", "investment", "investments", "investor", "investors", "to the moon", "mooning", "lambo", "pump", "pumping", "pumped", "price will",
  "will double", "will triple", "double your", "triple your", "get rich", "rich quick", "make money", "free money", "financial freedom",
  "presale", "pre sale", "airdrop", "airdrops", "giveaway", "buy now", "buy before", "last chance", "dont miss", "do not miss", "next bitcoin",
  "next solana", "millionaire", "millionaires", "early holders", "early buyers", "hidden gem coin", "moonshot", "ape in",
  "scam", "scammer", "rug", "rugpull", "rug pull", "rugged", "ponzi", "pyramid scheme", "pump and dump", "honeypot",
  // the review's second round (SCAM-1): returns for holding, money multiplied or given back, price targets, scarcity
  "staking", "stake to earn", "payout", "payouts", "just for holding", "for holding", "by holding", "hold to earn", "holders earn", "passive",
  "doubles your", "doubled your", "triples your", "your money", "money back", "times your money", "one dollar", "a dollar", "price target",
  "will hit", "will reach", "going to hit", "whitelist", "whitelisted", "white list", "allowlist", "allow list", "spots left", "spots remaining",
  "limited spots", "selling fast", "act fast", "hurry", "fomo", "too late", "yield farm", "yield farming", "liquidity mining", "make money fast",
]);

/**
 * Asking people to do something with their wallet, keys or money (SCAM-1): connect or "validate" a wallet, type a recovery phrase, send
 * coins to get more back, claim free tokens. FLAG ("wallet_ask"); src/screen.js walletAsk also reads "send 1 SOL ... back".
 */
export const WALLET_ASK = Object.freeze([
  "seed phrase", "recovery phrase", "secret phrase", "secret recovery phrase", "backup phrase", "wallet phrase", "passphrase", "private key",
  "mnemonic", "12 words", "24 words", "twelve words", "word phrase", "seed words", "secret words", "recovery words", "recovery key", "secret key",
  "connect your wallet", "connect wallet", "link your wallet", "validate your wallet",
  "validate wallet", "verify your wallet", "verify wallet", "sync your wallet", "sync wallet", "synchronize your wallet", "synchronise your wallet",
  "rectify", "restore your wallet", "import your wallet", "unlock your wallet", "enter your", "type your", "paste your", "share your",
  "claim free", "claim your", "claim tokens", "claim the", "claim now", "free tokens", "free coins", "free sol", "free crypto", "bonus tokens",
  "approve the transaction", "sign the transaction", "drainer",
]);

/**
 * Regulators and official-sounding claims, and people a coin could pretend to be backed by (SCAM-1): FLAG ("brand") wherever they stand.
 */
export const OFFICIAL_CLAIMS = Object.freeze([
  "sec", "fca", "cftc", "fdic", "finra", "esma", "federal reserve", "the fed", "insured", "fully insured", "licensed", "licenced", "regulated",
  "government backed", "state backed", "gold backed", "asset backed", "backed by", "endorsed by", "approved by", "certified by", "audited by",
  "sponsored by", "supported by", "partnered with", "in partnership with", "official partner", "official partners", "as seen on", "featured in",
  "featured on",
  "elon", "musk", "trump", "biden", "obama", "saylor", "vitalik", "buterin", "changpeng", "yakovenko", "mrbeast", "mr beast", "snoop dogg", "kanye",
  "kardashian", "bezos", "zuckerberg", "bill gates", "warren buffett", "jack dorsey", "satoshi nakamoto", "taylor swift", "the pope",
]);

/** Street words for the street-address rule (a house number, then a street word; or a street word, a name and a number). */
export const STREET_WORDS = Object.freeze([
  "street", "st", "avenue", "ave", "av", "road", "rd", "boulevard", "blvd", "lane", "ln", "drive", "dr", "way", "court", "ct", "place", "pl",
  "square", "sq", "terrace", "highway", "hwy", "parkway", "pkwy", "circle", "cir", "alley", "plaza", "row",
  "calle", "carrera", "avenida", "rua", "rue", "via", "viale", "corso", "piazza", "strasse", "straße", "str", "weg", "platz", "gasse", "allee",
  "laan", "straat", "gracht", "ulica", "ul", "utca", "ulitsa", "prospekt", "caddesi", "sokak", "jalan", "jl", "soi", "duong",
]);

/** The words that make a brand a claimed tie ("official partner", "backed by Binance", "Utica x Nike"). */
export const TIE_WORDS = Object.freeze(["official", "officially", "partner", "partners", "partnered", "partnership", "endorsed", "endorses", "endorsement",
  "sponsored", "sponsor", "sponsors", "backed", "backs", "supported", "approved", "affiliated", "collaboration", "by", "with", "x"]);
/** The words that make a public body a claimed tie ("endorsed by the city council", "the mayor's official coin"). */
export const BODY_TIE_WORDS = Object.freeze(["official", "officially", "endorsed", "endorses", "endorsement", "approved", "sponsored", "backed", "supported",
  "partner", "partnered", "affiliated", "by"]);

/** Staff words: "Vicinity" with one of these, or the word alone, sounds like it comes from Vicinity or its staff (src/me.js reservedUsername). */
export const STAFF_WORDS = Object.freeze(["team", "staff", "admin", "admins", "administrator", "moderator", "moderators", "mod", "mods", "support",
  "official", "officially", "approved", "endorsed", "partner", "partners", "verified", "founders"]);
export const STAFF_ALONE = Object.freeze(["admin", "admins", "administrator", "moderator", "moderators", "mods"]);

/**
 * The top-level domains a "word.word" can end in and be a web address: the generic ones in common use and every two-letter country code
 * (ISO 3166-1 alpha-2, plus uk, eu, ac). "St.Louis" or "Mt.Fuji" end in no such domain, so they pass; "utica.io" or "visit.nyc" do not.
 */
export const TLDS = Object.freeze([
  "com", "net", "org", "info", "biz", "io", "xyz", "app", "dev", "ai", "co", "me", "gg", "ly", "ee", "tv", "cc", "ws", "to", "sh", "so", "vc", "fm",
  "site", "online", "store", "shop", "tech", "club", "fun", "live", "life", "world", "today", "news", "blog", "page", "link", "click", "space",
  "website", "pro", "top", "vip", "win", "bet", "cash", "money", "finance", "capital", "fund", "exchange", "market", "markets", "trade", "trading",
  "crypto", "coin", "coins", "token", "tokens", "nft", "dao", "wallet", "city", "town", "nyc", "london", "berlin", "paris", "tokyo", "global",
  "network", "digital", "media", "social", "chat", "email", "mobi", "name", "asia", "africa", "gov", "edu", "mil", "int", "eth", "sol", "art",
  "ad", "ae", "af", "ag", "al", "am", "ao", "aq", "ar", "as", "at", "au", "aw", "ax", "az", "ba", "bb", "bd", "be", "bf", "bg", "bh", "bi", "bj",
  "bm", "bn", "bo", "br", "bs", "bt", "bw", "by", "bz", "ca", "cd", "cf", "cg", "ch", "ci", "ck", "cl", "cm", "cn", "cr", "cu", "cv", "cw", "cx",
  "cy", "cz", "de", "dj", "dk", "dm", "do", "dz", "ec", "eg", "er", "es", "et", "eu", "fi", "fj", "fk", "fo", "fr", "ga", "gb", "gd", "ge", "gf",
  "gh", "gi", "gl", "gm", "gn", "gp", "gq", "gr", "gs", "gt", "gu", "gw", "gy", "hk", "hm", "hn", "hr", "ht", "hu", "id", "ie", "il", "im", "in",
  "iq", "ir", "is", "it", "je", "jm", "jo", "jp", "ke", "kg", "kh", "ki", "km", "kn", "kp", "kr", "kw", "ky", "kz", "la", "lb", "lc", "li", "lk",
  "lr", "ls", "lt", "lu", "lv", "ma", "mc", "md", "mg", "mh", "mk", "ml", "mm", "mn", "mo", "mp", "mq", "mr", "ms", "mt", "mu", "mv", "mw", "mx",
  "my", "mz", "na", "nc", "ne", "nf", "ng", "ni", "nl", "no", "np", "nr", "nu", "nz", "om", "pa", "pe", "pf", "pg", "ph", "pk", "pl", "pm", "pn",
  "pr", "ps", "pt", "pw", "py", "qa", "re", "ro", "rs", "ru", "rw", "sa", "sb", "sc", "sd", "se", "sg", "si", "sk", "sl", "sm", "sn", "sr",
  "ss", "st", "sv", "sx", "sy", "sz", "tc", "td", "tf", "tg", "th", "tj", "tk", "tl", "tm", "tn", "tr", "tt", "tw", "tz", "ua", "ug", "uk", "us",
  "uy", "uz", "va", "ve", "vg", "vi", "vn", "vu", "wf", "ye", "yt", "za", "zm", "zw",
]);

/** Link hosts that are always a link, whatever their domain ("t.me/x", "discord.gg/x", "bit.ly/x", "linktr.ee/x"). */
export const LINK_HOSTS = Object.freeze(["t.me", "telegram.me", "discord.gg", "discord.com", "bit.ly", "linktr.ee", "x.com", "wa.me", "tinyurl.com"]);
/** Tickers a description may name besides its own: Vicinity's and the pairs. */
export const OK_TICKERS = Object.freeze(["VICINITY", "SOL", "USDC"]);

/*
 * The allow-list (src/screen.js plainChars and linkLike, ENGINE 3): what a founder's description must look like to pass by itself. Every
 * one of these only FLAGS (a person decides); nothing here refuses a text for good.
 */
/** Web endings that are not English words: a word, a SPACE and one of these reads as an address with the dot left out ("uticacoin com"). */
export const SPACED_TLDS = Object.freeze(["com", "org", "io", "xyz", "gg", "ly", "biz", "cc", "ws", "sh", "ru", "onion"]);
/**
 * Web endings read as an address after "visit", "go to", "at", "on"... and one word, with a space, a comma or a dash for the dot ("Visit
 * mvmoon net", "at moon-app"), or after a word the screener does not know ("mvmoon co"). Never after "us", "you" or the city's own name.
 */
export const WEB_TLDS = Object.freeze(["com", "net", "org", "io", "xyz", "gg", "ly", "biz", "cc", "ws", "sh", "ru", "onion", "co", "app", "info", "site",
  "online", "tv", "me", "to", "fun", "live", "sbs", "cfd", "icu", "lol", "wtf", "vip", "top", "club", "store", "shop", "fi", "ai", "so", "dev", "page", "link"]);
/** Words that point at an address ("Visit mvmoon net"). */
export const LINK_LEADS = Object.freeze(["visit", "go", "goto", "at", "on", "via", "see", "check", "find", "head", "browse", "open", "join"]);
/** Words read as the dot of an address ("mvmoon period net", "mvmoon punto net"). */
export const DOT_WORDS = Object.freeze(["dot", "d0t", "period", "punto", "punkt", "point", "ponto"]);
/** More link hosts written with a space for the dot ("youtu be", "t co"), besides LINK_HOSTS ("t me", "bit ly", "x com"). */
export const SPACED_HOSTS = Object.freeze(["youtu.be", "instagr.am", "fb.me", "fb.com", "t.co", "tiktok.com", "twitter.com", "discordapp.com", "pump.fun"]);
/** Platforms: their name anywhere in a description is a pointer to a social account or a chat. */
export const PLATFORMS = Object.freeze(["twitter", "telegram", "discord", "instagram", "insta", "tiktok", "youtube", "facebook", "snapchat", "whatsapp", "wechat",
  "reddit", "bluesky", "bsky", "linktree", "linktr", "onlyfans", "twitch", "weibo", "kakaotalk", "viber", "pinterest", "linkedin", "tumblr", "dexscreener", "pumpfun",
  "farcaster", "warpcast", "mastodon", "gmail", "googlemail", "protonmail", "hotmail", "icloud", "yahoo", "aol", "gmx", "yandex", "groupchat", "chatgroup"]);
/**
 * Platform, mail and chat names that are also letters or ordinary words: a pointer only within two words after one of CONTACT_WORDS
 * ("on X", "follow tg", "our IG", "on the gram", "join our server", "at outlook").
 */
export const PLATFORM_SHORT = Object.freeze(["x", "tg", "ig", "fb", "yt", "vk", "gram", "snap", "tele", "threads", "signal", "kick", "rumble", "outlook", "proton",
  "mail", "inbox", "server", "servers", "gc", "chat", "channel"]);
/** The words that send a reader to an account: "follow ...", "join ...", "on X", "our IG", "DM me". */
export const CONTACT_WORDS = Object.freeze(["follow", "join", "find", "search", "dm", "message", "add", "on", "via", "our", "my", "your", "at", "email"]);
/** "DM me", "text us": a request to be contacted privately. */
export const CONTACT_ME = Object.freeze(["dm", "pm", "message", "text", "call", "contact", "ping", "whatsapp", "telegram", "signal"]);
/** What a handle or a domain glues to a city's own name: "uticacoin", "uticaofficial", "visitutica", "theutica". */
export const HANDLE_SUFFIXES = Object.freeze(["coin", "coins", "token", "tokens", "official", "hq", "app", "club", "dao", "sol", "crypto", "fans", "army", "gang",
  "community", "news", "xyz", "io", "com", "net", "org", "online", "live", "tv", "fm", "bot", "dev", "labs", "nft", "meme", "moon", "pump", "cash", "money", "finance",
  "swap", "dex"]);
export const HANDLE_PREFIXES = Object.freeze(["the", "real", "official", "get", "join", "visit", "my", "go", "team", "ilove", "love", "we", "buy", "i"]);

/*
 * The word allow-list (src/screen.js knownWords, ENGINE 4): a founder's description passes by itself only when every word in it is one the
 * screener knows: everyday English (src/screen-vocab.js ENGLISH, from SCOWL), a word of a place name in the Vicinity city list
 * (src/screen-vocab.js PLACES), the city's own name, region and country (and "Uticans", "Londoners"), a number, or a word below. Any other
 * word (a local name, another language, a new spelling, a slur nobody listed) is FLAGGED for a person. Only the lists above refuse.
 */
/** Proper names and capitalised words the English list leaves out: days, months, holidays, faiths, peoples and languages, regions. */
const plural = (ws) => ws.flatMap((w) => (/(?:ese|ish|ch|ss|sh|x|z|i)$/.test(w) ? [w] : [w, /y$/.test(w) && !/[aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`]));
export const PROPER_WORDS = Object.freeze([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mondays", "tuesdays", "wednesdays", "thursdays", "fridays", "saturdays", "sundays",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "christmas", "easter", "halloween", "thanksgiving", "hanukkah", "chanukah", "diwali", "ramadan", "eid", "passover", "kwanzaa", "juneteenth", "valentine",
  "valentines", "lent", "advent", "pentecost", "oktoberfest", "carnaval", "hogmanay", "holi", "nowruz", "songkran", "chuseok", "tet", "fiesta", "fiestas",
  ...plural(["christian", "catholic", "protestant", "jew", "muslim", "hindu", "sikh", "buddhist", "jain", "taoist", "quaker", "mormon", "mennonite", "baptist",
    "methodist", "lutheran", "anglican", "presbyterian", "evangelical"]),
  "jewish", "islamic", "christianity", "catholicism", "judaism", "islam", "hinduism", "sikhism", "buddhism", "amish", "shinto", "episcopal", "god", "allah",
  "jesus", "christ", "moses", "muhammad", "buddha", "bible", "koran", "quran", "torah", "sabbath", "shabbat",
  "africa", "america", "americas", "asia", "europe", "oceania", "antarctica", "arctic", "atlantic", "pacific", "caribbean", "mediterranean", "baltic",
  "balkans", "balkan", "scandinavia", "nordic", "midwest", "midwestern", "appalachia", "appalachian", "appalachians", "adirondack", "adirondacks", "rockies",
  "sahara", "amazon", "andes", "alps", "alpine", "himalaya", "himalayas", "himalayan", "nile", "thames", "rhine", "danube", "seine", "hudson", "mississippi",
  "potomac", "niagara", "mohawk", "erie", "huron", "everest", "kilimanjaro", "fuji", "olympus", "gateway",
  ...plural(["african", "american", "asian", "european", "afghan", "albanian", "algerian", "andorran", "angolan", "argentine", "argentinian", "armenian",
    "australian", "austrian", "azerbaijani", "bahamian", "bahraini", "bangladeshi", "barbadian", "belarusian", "belgian", "belizean", "bolivian", "bosnian",
    "brazilian", "briton", "bulgarian", "cambodian", "cameroonian", "canadian", "chadian", "chilean", "colombian", "croatian", "cuban", "cypriot", "czech",
    "dane", "dominican", "ecuadorian", "egyptian", "emirati", "eritrean", "estonian", "ethiopian", "fijian", "filipino", "filipina", "finn", "gabonese",
    "gambian", "georgian", "german", "ghanaian", "greek", "grenadian", "guatemalan", "guinean", "haitian", "honduran", "hungarian", "icelander", "indian",
    "indonesian", "iranian", "iraqi", "israeli", "italian", "ivorian", "jamaican", "jordanian", "kazakh", "kenyan", "korean", "kosovar", "kuwaiti", "laotian",
    "latvian", "liberian", "libyan", "lithuanian", "luxembourger", "malawian", "malaysian", "maldivian", "malian", "mauritanian", "mauritian", "mexican",
    "moldovan", "mongolian", "montenegrin", "moroccan", "mozambican", "namibian", "nicaraguan", "nigerian", "nigerien", "norwegian", "omani", "pakistani",
    "palestinian", "panamanian", "paraguayan", "peruvian", "pole", "qatari", "romanian", "russian", "rwandan", "salvadoran", "samoan", "saudi", "scot",
    "senegalese", "serbian", "singaporean", "slovak", "slovakian", "slovenian", "somali", "spaniard", "lankan", "swede", "syrian", "tajik", "tanzanian",
    "thai", "togolese", "tongan", "trinidadian", "tunisian", "turk", "turkmen", "ugandan", "ukrainian", "uruguayan", "uzbek", "venezuelan", "yemeni",
    "zambian", "zimbabwean", "zealander", "kiwi", "arab", "persian", "kurd", "berber", "tamil", "punjabi", "bengali", "gujarati", "maori", "aboriginal",
    "inuit", "cherokee", "navajo", "apache", "sioux", "iroquois", "oneida", "cajun", "creole", "celt", "basque", "catalan", "galician", "fleming",
    "bavarian", "prussian", "sicilian", "neapolitan", "venetian", "tuscan", "texan", "californian", "yorker", "bostonian", "londoner", "parisian",
    "berliner", "roman", "aztec", "maya", "mayan", "inca", "viking", "saxon", "norman", "latino", "latina", "hispanic", "native", "immigrant", "settler",
    "pilgrim", "puritan", "yankee", "irishman", "irishwoman", "scotsman", "englishman", "welshman", "frenchman", "dutchman"]),
  "chinese", "japanese", "vietnamese", "burmese", "nepalese", "lebanese", "sudanese", "portuguese", "maltese", "congolese", "taiwanese", "bhutanese",
  "beninese", "guyanese", "surinamese", "english", "british", "irish", "scottish", "scots", "welsh", "cornish", "french", "dutch", "danish", "finnish",
  "swedish", "polish", "spanish", "turkish", "flemish", "swiss", "icelandic", "kurdish", "luxembourgish", "kyrgyz", "lao", "nepali", "malagasy", "seychellois",
  "monegasque", "anglo", "celtic", "gaelic", "nordic", "arabic", "hebrew", "hindi", "urdu", "swahili", "cantonese", "mandarin", "hakka", "hmong", "yiddish",
  "esperanto", "latin", "indigenous", "jewry",
  "nfl", "nba", "mlb", "nhl", "mls", "fifa", "uefa", "olympics", "olympic", "paralympics", "unesco",
]);
/** Abbreviations, contractions (the part before the apostrophe: "isn't"), web and crypto words, and food and culture words founders use. */
export const EXTRA_WORDS = Object.freeze([
  "st", "mt", "ft", "dr", "mr", "mrs", "ms", "jr", "sr", "ave", "rd", "blvd", "hwy", "usa", "us", "uk", "eu", "un", "nyc", "la", "dc", "sf", "ny", "nj", "tv",
  "dj", "bbq", "diy", "etc", "vs", "no", "km", "mi", "kg", "lb", "lbs", "oz", "mph", "kph", "sq", "hr", "hrs", "min", "mins", "sec", "secs", "am", "pm", "ok",
  "okay", "ad", "bc", "bce", "ce", "aka", "asap", "fyi", "ufo", "co", "inc", "ltd", "dept", "univ", "est", "approx", "vol", "no", "nos", "pt", "ft",
  "al", "ak", "az", "ar", "ca", "ct", "de", "fl", "ga", "hi", "id", "il", "ia", "ks", "ky", "md", "ma", "mn", "mo", "ne", "nv", "nh", "nm", "nc", "nd",
  "oh", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "ab", "mb", "nb", "nl", "ns", "nt", "nu", "pe", "qc", "sk", "yt",
  "isn", "aren", "doesn", "didn", "wasn", "couldn", "shouldn", "wouldn", "hasn", "haven", "weren", "ain", "mustn", "needn", "re", "ve", "ll",
  "crypto", "cryptocurrency", "cryptocurrencies", "blockchain", "blockchains", "solana", "memecoin", "memecoins", "onchain", "defi", "nft", "nfts", "dao",
  "daos", "hodl", "hodlers", "gm", "online", "website", "websites", "app", "apps", "email", "emails", "selfie", "selfies", "hashtag", "livestream",
  "beignet", "beignets", "cheesesteak", "cheesesteaks", "pierogi", "pierogis", "pierogies", "crawfish", "boudin", "gelato", "ramen", "dosa", "dosas",
  "jollof", "ceviche", "paella", "mariachi", "tequila", "flamenco", "fjord", "fjords", "tram", "trams", "sushi", "taco", "tacos", "burrito", "burritos",
  "pho", "kimchi", "falafel", "hummus", "kebab", "kebabs", "shawarma", "naan", "samosa", "samosas", "biryani", "poutine", "schnitzel", "bratwurst",
  "pretzel", "pretzels", "strudel", "croissant", "croissants", "baguette", "baguettes", "crepe", "crepes", "tapas", "sangria", "empanada", "empanadas",
  "arepa", "arepas", "pupusa", "pupusas", "tamale", "tamales", "churro", "churros", "mezcal", "sake", "soju", "boba", "matcha", "chai", "espresso",
  "cappuccino", "latte", "lattes", "bagel", "bagels", "lox", "pastrami", "poke", "aloha", "luau", "bodega", "bodegas", "bistro", "bistros", "brasserie",
  "trattoria", "pizzeria", "pizzerias", "taqueria", "cantina", "siesta", "samba", "tango", "salsa", "reggae", "reggaeton", "kpop", "zydeco", "bluegrass",
  "techno", "hiphop", "jeepney", "jeepneys", "hawker", "hawkers", "corniche", "dumpling", "dumplings", "noodle", "noodles",
  "brisket", "barbecue", "tortilla", "tortillas", "guacamole", "nachos", "quesadilla", "souvlaki", "gyro", "gyros",
  "baklava", "tzatziki", "risotto", "lasagna", "lasagne", "cannoli", "tiramisu", "prosecco", "chianti", "pinot", "merlot", "riesling", "sauerkraut",
  "goulash", "borscht", "blini", "pelmeni", "tagine", "couscous", "jerk", "plantain", "plantains", "injera", "ugali", "nyama", "braai", "boerewors", "pavlova",
  "lamington", "lamingtons", "vegemite", "haggis", "scone", "scones", "crumpet", "crumpets", "chowder", "lobster", "gumbo", "jambalaya", "etouffee",
  "grits", "cornbread", "biscuits", "tamale", "chile", "chiles", "salsa", "queso", "horchata", "kombucha", "acai", "poke", "smoothie", "smoothies",
  "skatepark", "skateparks", "streetcar", "streetcars", "riverwalk", "boardwalk", "boardwalks", "rooftop", "rooftops", "foodie", "foodies", "downtown",
  "uptown", "midtown", "hometown", "neighbourhood", "neighbourhoods", "neighborhood", "neighborhoods",
  // the world's dishes, drinks and pastimes founders name (FP: a description of a city's food is not another language)
  "hotdish", "stroopwafel", "stroopwafels", "nata", "natas", "pastel", "pasteis", "fado", "simit", "pilsner", "pilsners", "tuk", "tuks", "asado", "asados",
  "koshari", "vada", "pav", "bhaji", "bhajis", "dal", "dhal", "chaat", "lassi", "thali", "paratha", "parathas", "roti", "rotis", "idli", "idlis", "masala",
  "tikka", "korma", "vindaloo", "tandoori", "chutney", "pakora", "pakoras", "jalebi", "kulfi", "momo", "momos", "laksa", "satay", "rendang", "nasi",
  "goreng", "mee", "roti", "kaya", "teh", "tarik", "adobo", "lechon", "halo", "sinigang", "bao", "baozi", "jiaozi", "xiaolongbao", "wonton", "wontons",
  "chow", "mein", "congee", "hotpot", "mochi", "onigiri", "udon", "soba", "tempura", "takoyaki", "okonomiyaki", "yakitori", "izakaya", "izakayas", "bento",
  "sake", "matcha", "bibimbap", "bulgogi", "tteokbokki", "soju", "makgeolli", "banchan", "pho", "banh", "bun", "nem", "som", "tam", "larb", "khao",
  "tom", "yum", "pad", "thai", "currywurst", "bratwurst", "schnitzel", "spaetzle", "brezel", "lebkuchen", "stollen", "gluhwein", "biergarten",
  "biergartens", "kolsch", "weissbier", "doner", "kebap", "baklava", "borek", "lahmacun", "pide", "meze", "mezze", "raki", "ouzo", "gyros", "moussaka",
  "spanakopita", "halloumi", "dolma", "dolmas", "kofta", "shakshuka", "labneh", "manakish", "fattoush", "tabbouleh", "mansaf", "kunafa", "knafeh",
  "baba", "ghanoush", "harira", "pastilla", "msemen", "brik", "tajine", "jollof", "suya", "egusi", "fufu", "injera", "ugali", "chapati", "chapatis",
  "nyama", "choma", "biltong", "bobotie", "bunny", "chow", "boerewors", "potjie", "piri", "peri", "pastel", "feijoada", "brigadeiro", "brigadeiros",
  "acai", "caipirinha", "churrasco", "coxinha", "pao", "queijo", "empanada", "chimichurri", "dulce", "leche", "alfajor", "alfajores", "mate", "malbec",
  "asado", "milanesa", "choripan", "arepa", "cachapa", "ceviche", "lomo", "saltado", "pisco", "chicha", "anticuchos", "tamal", "pozole", "mole",
  "elote", "elotes", "esquites", "tlayuda", "tlayudas", "michelada", "micheladas", "horchata", "agua", "fresca", "cafecito", "cortadito", "cubano",
  "cubanos", "mojito", "mojitos", "tostones", "maduros", "mofongo", "jerk", "patty", "patties", "roti", "doubles", "ackee", "saltfish", "poutine",
  "tourtiere", "bannock", "nanaimo", "ketchup", "lobster", "chowder", "gumbo", "beignet", "muffuletta", "boudin", "etouffee", "jambalaya", "grits",
  "biscuits", "barbecue", "brisket", "burnt", "ends", "kolache", "kolaches", "pierogi", "kielbasa", "goulash", "langos", "trdelnik", "svickova",
  "borscht", "pelmeni", "vareniki", "pirozhki", "blini", "smorrebrod", "smorgasbord", "fika", "kanelbulle", "lutefisk", "pastry", "pastries",
  "croissant", "macaron", "macarons", "crepe", "galette", "galettes", "boulangerie", "patisserie", "bouillabaisse", "ratatouille", "cassoulet",
  "tartiflette", "raclette", "fondue", "rosti", "carbonara", "amatriciana", "cacio", "pepe", "supplì", "suppli", "arancini", "cannolo", "cannoli",
  "sfogliatella", "gelato", "gelateria", "aperitivo", "spritz", "negroni", "limoncello", "focaccia", "risotto", "ossobuco", "tiramisu", "panettone",
  "churros", "tapas", "pintxos", "paella", "tortilla", "jamon", "gazpacho", "salmorejo", "sangria", "vermut", "pulpo", "cocido", "bacalhau",
  "francesinha", "bifana", "ginjinha", "vinho", "verde", "haggis", "neeps", "tatties", "shortbread", "crumpet", "scone", "scones", "trifle",
  "pasty", "pasties", "chippy", "fry", "boxty", "coddle", "colcannon", "stout", "porter", "cider", "lager", "ale", "ales", "laneway", "laneways",
  "flat", "white", "lamington", "pavlova", "vegemite", "pie", "floater", "hangi", "pavlova", "kai", "poke", "loco", "moco", "spam", "musubi",
  "malasada", "malasadas", "shave", "ice", "luau", "ukulele", "hula", "samba", "bossa", "nova", "forro", "capoeira", "tango", "milonga", "cumbia",
  "salsa", "bachata", "merengue", "reggaeton", "mariachi", "banda", "norteno", "flamenco", "fado", "rebetiko", "klezmer", "polka", "zydeco",
  "bluegrass", "afrobeat", "afrobeats", "highlife", "amapiano", "kwaito", "bhangra", "bollywood", "qawwali", "gamelan", "kpop", "jpop", "anime",
  "manga", "karaoke", "pachinko", "onsen", "ryokan", "hanami", "matsuri", "souk", "souks", "medina", "medinas", "riad", "riads", "hammam", "hammams",
  "bazaar", "bazaars", "hawker", "hawkers", "kopitiam", "dhaba", "dhabas", "chai", "tuk", "rickshaw", "rickshaws", "jeepney", "jeepneys", "matatu",
  "matatus", "boda", "dala", "piazza", "piazzas", "plaza", "plazas", "zocalo", "malecon", "rambla", "ramblas", "corniche", "promenade", "boardwalk",
]);
/** Words known only next to each other ("honky tonk", "art deco"): alone, each is unknown (or a slur: "honky"). */
export const VOCAB_PAIRS = Object.freeze(["honky tonk", "honky tonks", "art deco", "mardi gras", "boda boda", "boda bodas", "dim sum", "banh mi"]);
/** Only in VOCAB_PAIRS, never alone. */
export const PAIR_ONLY = Object.freeze(["honky", "tonk", "tonks", "deco", "mardi", "gras", "boda", "bodas", "banh"]);
/**
 * Words taken out of the vocabulary although the English list has them: slurs and words used as slurs that no list above names exactly
 * (every word of SLURS, ABUSE and FOREIGN_SLURS, with its plurals, is taken out too). An unknown word is flagged, and read against the
 * slurs spelled another way (src/screen.js slurLike).
 */
export const VOCAB_DENY = Object.freeze(["nigger", "niggers", "nigga", "niggas", "negroes", "negresses", "darkie", "darkies", "darkey", "pickaninnies",
  "golliwogs", "wogs", "wops", "dagos", "dagoes", "spics", "spicks", "kikes", "yids", "sheenies", "hebe", "hebes", "gooks", "chinks", "coons", "squaws",
  "redskins", "injuns", "halfbreeds", "mulattoes", "mulattos", "coolie", "coolies", "gringo", "gringos", "kraut", "krauts", "jap", "japs", "paki", "pakis",
  "ragheads", "towelheads", "wetbacks", "beaners", "faggot", "faggots", "fagot", "fagots", "faggoting", "fagoting", "fag", "fags", "dykes", "homos",
  "shemales", "poofs", "poofters", "retards", "mongol", "mongols", "mongoloids", "spastics", "sodomites", "gyps", "gypped", "gypping", "jewed", "jewing",
  "honkies", "honkeys", "honkey"]);
/** A vocabulary word with one of these inside is taken out too ("fuckhead", "shithead"): the English list has many such compounds. */
export const DENY_PARTS = Object.freeze(["fuck", "shit", "cunt", "nigg", "fagg", "twat", "wank", "whore", "slut", "bitch", "bollock", "jizz", "dildo", "porn",
  "rapist", "nazi", "kike", "cock", "dick", "pussy", "bastard", "asshole", "arsehole", "piss", "tits", "boob", "retard", "spaz"]);
/**
 * A word written as a name is never taken for one (src/screen.js allowedNames) within three words after one of these: it may be a
 * handle ("Follow Mvmoon", "Message Moonboys for a deal", "Visit Mvmoon").
 */
export const NAME_GUARD_WORDS = Object.freeze(["follow", "message", "dm", "pm", "text", "call", "contact", "ping", "add", "email", "mail", "subscribe", "tag",
  "mention", "ask", "write", "join", "find", "reach", "search", "visit", "via", "handle", "username", "user", "account", "page", "channel", "group", "server"]);
/** What makes a people's name of a city's own name: "Uticans", "Londoners", "Bostonians", "Parisians", "Romans". */
export const DEMONYM_SUFFIXES = Object.freeze(["n", "ns", "an", "ans", "ian", "ians", "ite", "ites", "er", "ers", "ese", "i", "is", "ish", "eno", "enos", "ena",
  "enas", "ino", "inos", "ina", "inas", "ois", "oise", "ite", "ites"]);
/**
 * Slurs of other languages (the site's founders write from every country): FLAG ("slur_like") on a word the English list does not know
 * (Polish "pedał" is also "pedal"). Every other word of another language is flagged anyway: a person reads it.
 */
export const FOREIGN_SLURS = Object.freeze([
  "kanake", "kanaken", "neger", "negern", "zigeuner", "schwuchtel", "schwuchteln", "kuemmeltuerke", "kummelturke", "kameltreiber", "judensau",
  "untermensch", "untermenschen", "fidschi", "fidschis", "polacke", "polacken",
  "bougnoule", "bougnoules", "youpin", "youpins", "youtre", "youtres", "negre", "negres", "bicot", "bicots", "raton", "ratons", "pede", "pedes", "tapette",
  "tapettes", "gouine", "gouines", "chinetoque", "chinetoques", "bamboula", "bamboulas", "crouille", "crouilles",
  "sudaca", "sudacas", "maricon", "maricones", "marica", "maricas", "negrata", "negratas", "panchito", "panchitos", "tortillera", "tortilleras", "bollera",
  "bolleras", "mariconazo",
  "frocio", "froci", "ricchione", "ricchioni", "terrone", "terroni", "zingaro", "zingari", "checca", "checche",
  "viado", "viados", "sapatao", "sapatona",
  "pedal", "pedaly", "pedale", "pedalami", "pedalow", "ciota", "cioty", "czarnuch", "czarnuchy",
  "nikker", "nikkers", "flikker", "flikkers", "moffen", "ibne", "zhid", "zhidy", "khach", "churka", "churki", "pidor", "pidory", "pidaras", "pidoras",
  "blatte", "blattar", "perker", "perkere",
  // English slurs that are no English word (so a word nobody knows, spelled any way, is read against them): a person decides
  "abo", "abbo", "boche", "bosche", "gweilo", "gwailo", "schvartze", "schwartze", "shvartze", "kaffer", "coonass", "bohunk", "wigger", "wigga",
  "mayate", "mulignan", "moolinyan", "taig", "moskal", "katsap", "khokhol", "chukhna", "muzzie", "lubra", "pikie", "spacker", "spakka", "flid",
  "tard", "libtard", "lezzer", "lezza", "lesbo", "lezbo", "bumboy", "faggy", "fagbag", "slopehead", "gooky", "chinkies", "dindu", "jiggaboo",
  "sheboon", "groid", "jewboy", "yiddo", "guido",
]);
/**
 * Groups of people (src/screen.js hateNear): within four words of a violent or dehumanising word (VIOLENCE_WORDS) in the same sentence,
 * or with an exclusion ("no Jews allowed", "Muslims out", "gays go home"), FLAG ("abuse"). Peoples are named in the plural (a
 * "Mexican restaurant" is not a group of people); faiths, sexualities and "trans" in both.
 */
export const GROUP_WORDS = Object.freeze([
  "jew", "jews", "jewish", "jewry", "muslim", "muslims", "moslem", "moslems", "islam", "islamic", "christians", "catholics", "hindus", "sikhs", "buddhists",
  "atheists", "gay", "gays", "lesbian", "lesbians", "homosexual", "homosexuals", "bisexuals", "trans", "transgender", "transgenders", "queers", "lgbt",
  "lgbtq", "immigrant", "immigrants", "migrant", "migrants", "refugee", "refugees", "foreigners", "blacks", "whites", "arabs", "asians", "africans", "latinos",
  "latinas", "hispanics", "gypsies", "roma", "women", "girls", "mexicans", "indians", "pakistanis", "somalis", "haitians", "nigerians", "chinese", "jamaicans",
  "russians", "ukrainians", "poles", "turks", "kurds", "palestinians", "israelis", "iranians", "iraqis", "afghans", "syrians", "albanians", "romanians",
  "italians", "koreans", "japanese", "vietnamese", "filipinos", "cubans", "dominicans", "salvadorans", "guatemalans", "hondurans", "venezuelans",
  "colombians", "brazilians", "zionists", "germans", "americans", "british", "irish", "scots", "english", "french", "mosque", "mosques",
  "synagogue", "synagogues",
]);
/** Violent or dehumanising words (src/screen.js hateNear): with a group of people (GROUP_WORDS) nearby, FLAG ("abuse"). */
export const VIOLENCE_WORDS = Object.freeze([
  "kill", "kills", "killed", "killing", "murder", "murdered", "murdering", "lynch", "lynched", "lynching", "hang", "hanged", "hanging", "gas", "gassed",
  "gassing", "shoot", "shooting", "stab", "stabbed", "burn", "burned", "burnt", "stoned", "stoning", "exterminate", "exterminated", "extermination",
  "eradicate", "eradicated", "purge", "purged", "cleanse", "cleansed", "cleansing", "deport", "deported", "deportation", "expel", "expelled", "ban",
  "banned", "slaughter", "slaughtered", "massacre", "massacred", "genocide", "enslave", "enslaved", "behead", "beheaded", "rape", "raped", "castrate",
  "sterilize", "sterilise", "drown", "drowned", "hate", "hated", "hates", "vermin", "rats", "cockroaches", "parasites", "animals", "apes", "monkeys",
  "subhuman", "subhumans", "invaders", "invasion", "inferior", "destroy", "destroyed", "wipe", "raus", "ovens", "chambers", "filth", "scum", "disease",
]);
/** An exclusion right after a group of people ("Jews out", "gays go home", "Muslims not welcome"), or around it ("no Jews allowed"). */
export const EXCLUSION_AFTER = Object.freeze(["out", "raus", "go home", "go back", "get out", "not welcome", "not allowed", "keep out", "stay out", "leave", "must go",
  "should leave", "are not welcome", "are not allowed", "never welcome"]);
/** The scripts a country's own names and words are written in (FP-1): plain for its cities too, besides A to Z. "CC:Script,Script". */
export const COUNTRY_SCRIPTS = Object.freeze([
  "JP:Han,Hiragana,Katakana", "CN:Han", "TW:Han", "HK:Han", "MO:Han", "SG:Han,Tamil", "KR:Hangul,Han", "KP:Hangul",
  "RU:Cyrillic", "UA:Cyrillic", "BG:Cyrillic", "RS:Cyrillic", "BY:Cyrillic", "KZ:Cyrillic", "KG:Cyrillic", "MK:Cyrillic", "MN:Cyrillic,Mongolian", "TJ:Cyrillic",
  "ME:Cyrillic", "BA:Cyrillic", "GR:Greek", "CY:Greek", "IL:Hebrew", "AE:Arabic", "SA:Arabic", "EG:Arabic", "IQ:Arabic", "JO:Arabic", "KW:Arabic", "LB:Arabic",
  "LY:Arabic", "MA:Arabic", "OM:Arabic", "QA:Arabic", "SY:Arabic", "TN:Arabic", "YE:Arabic", "DZ:Arabic", "BH:Arabic", "SD:Arabic", "PS:Arabic", "MR:Arabic",
  "IR:Arabic", "AF:Arabic", "PK:Arabic", "IN:Devanagari,Bengali,Gurmukhi,Gujarati,Oriya,Tamil,Telugu,Kannada,Malayalam", "NP:Devanagari", "BD:Bengali",
  "LK:Sinhala,Tamil", "TH:Thai", "LA:Lao", "KH:Khmer", "MM:Myanmar", "ET:Ethiopic", "ER:Ethiopic", "GE:Georgian", "AM:Armenian", "MV:Thaana", "BT:Tibetan",
]);

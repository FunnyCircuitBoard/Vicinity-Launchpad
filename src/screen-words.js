/**
 * The word lists of the description screener (src/screen.js). Plain arrays, for the owner to review (decision D10: slurs BLOCK, every
 * other list only FLAGS, so a person looks before anything is refused for good). Changing any list changes src/screen.js RULES_VERSION,
 * and a founder description that passed under older lists is screened again before it can launch.
 *
 * The lists are the LAST of three checks, not the first: a description passes by itself only when (a) every character is a plain one
 * (src/screen.js plainChars: the letters of the city's own script and A to Z, the digits 0 to 9, everyday punctuation and spaces), (b)
 * nothing in it looks like a link, an address or a handle (linkLike, with the allow-list words at the end of this file), and (c) none of
 * the lists below finds anything. Fancy-text styles, other alphabets and new spellings are therefore never matched against a list at all:
 * they are flagged for a person whatever they spell.
 *
 * Every entry is written in plain lower-case letters. The screener compares them with the text after folding it: Unicode compatibility
 * forms, letter case, accents, look-alike letters from other scripts, leetspeak (0 o, 1 i, 3 e, 4 a, 5 s, 7 t, @ a, $ s), dots, dashes
 * and spaces between single letters ("s.c.a.m", "s c a m"). Single words match whole words only (so "Scunthorpe", "Essex" or "Penistone"
 * never match a shorter word inside them), with or without a plural "s"; an entry with a space matches that run of words. A city's own
 * name, region, country and ticker never count against it.
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
/** More link hosts written with a space for the dot ("youtu be", "t co"), besides LINK_HOSTS ("t me", "bit ly", "x com"). */
export const SPACED_HOSTS = Object.freeze(["youtu.be", "instagr.am", "fb.me", "fb.com", "t.co", "tiktok.com", "twitter.com", "discordapp.com", "pump.fun"]);
/** Platforms: their name anywhere in a description is a pointer to a social account or a chat. */
export const PLATFORMS = Object.freeze(["twitter", "telegram", "discord", "instagram", "insta", "tiktok", "youtube", "facebook", "snapchat", "whatsapp", "wechat",
  "reddit", "bluesky", "bsky", "linktree", "linktr", "onlyfans", "twitch", "weibo", "kakaotalk", "viber", "pinterest", "linkedin", "tumblr", "dexscreener", "pumpfun"]);
/** Platform names that are also letters or ordinary words: a pointer only right after one of CONTACT_WORDS ("on X", "follow tg"). */
export const PLATFORM_SHORT = Object.freeze(["x", "tg", "ig", "fb", "yt", "threads", "vk"]);
/** The words that send a reader to an account: "follow ...", "join ...", "on X", "DM me". */
export const CONTACT_WORDS = Object.freeze(["follow", "join", "find", "search", "dm", "message", "add", "on", "via"]);
/** "DM me", "text us": a request to be contacted privately. */
export const CONTACT_ME = Object.freeze(["dm", "pm", "message", "text", "call", "contact", "ping", "whatsapp", "telegram", "signal"]);
/** What a handle or a domain glues to a city's own name: "uticacoin", "uticaofficial", "visitutica", "theutica". */
export const HANDLE_SUFFIXES = Object.freeze(["coin", "coins", "token", "tokens", "official", "hq", "app", "club", "dao", "sol", "crypto", "fans", "army", "gang",
  "community", "news", "xyz", "io", "com", "net", "org", "online", "live", "tv", "fm", "bot", "dev", "labs", "nft", "meme", "moon", "pump", "cash", "money", "finance",
  "swap", "dex"]);
export const HANDLE_PREFIXES = Object.freeze(["the", "real", "official", "get", "join", "visit", "my", "go", "team", "ilove", "love", "we", "buy", "i"]);

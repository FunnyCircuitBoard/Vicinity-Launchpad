// The description screener's allow-list (src/screen.js ENGINE 3): a founder's description passes by itself only when every character is a
// plain one for the city, nothing reads as a link or a handle, and the word lists find nothing. Everything else is flagged for a person
// (or refused). The evasion corpus: every string of the verification (NEW review: SEC-1 and SEC-2 residuals) and 44 generated
// "fancy text" styles applied to 5 slurs and 5 links: none may pass. And what must still pass: ordinary descriptions in English and in
// the city's own script, for registry cities and for cities named in other scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { screenDescription, screenName } from "../src/screen.js";

const UTICA = { city: { name: "Utica", region: "New York", countryName: "United States", country: "US" }, ticker: "UTICA" };
const shown = (t, r) => `${JSON.stringify(t)} → ${r.result} ${JSON.stringify(r.issues.map((x) => `${x.code}:${t.slice(x.start, x.end)}`))}`;

/* ---------------------------------------------------------------- the styles, as the "fancy text" generator sites make them */
const cp = (n) => String.fromCodePoint(n);
/** A Mathematical Alphanumeric Symbols alphabet: capitals at A, small letters at a (the holes are filled from Letterlike Symbols). */
const math = (A, a, holes = {}) => (s) => [...s].map((c) => holes[c] || (/[A-Z]/.test(c) ? cp(A + c.charCodeAt(0) - 65) : /[a-z]/.test(c) ? cp(a + c.charCodeAt(0) - 97) : c)).join("");
const table = (from, to) => { const f = [...from], t = [...to]; return (s) => [...s].map((c) => { const i = f.indexOf(c.toLowerCase()); return i >= 0 ? t[i] : c; }).join(""); };
const az = "abcdefghijklmnopqrstuvwxyz";
const perChar = (fn) => (s) => [...s].map(fn).join("");
const between = (sep) => (s) => [...s].join(sep);
const STYLES = {
  "math bold": math(0x1d400, 0x1d41a),
  "math italic": math(0x1d434, 0x1d44e, { h: "ℎ" }),
  "math bold italic": math(0x1d468, 0x1d482),
  "math script": math(0x1d49c, 0x1d4b6, { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ", e: "ℯ", g: "ℊ", o: "ℴ" }),
  "math bold script": math(0x1d4d0, 0x1d4ea),
  "math fraktur": math(0x1d504, 0x1d51e, { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" }),
  "math bold fraktur": math(0x1d56c, 0x1d586),
  "math double-struck": math(0x1d538, 0x1d552, { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" }),
  "math sans": math(0x1d5a0, 0x1d5ba),
  "math sans bold": math(0x1d5d4, 0x1d5ee),
  "math sans italic": math(0x1d608, 0x1d622),
  "math sans bold italic": math(0x1d63c, 0x1d656),
  "math monospace": math(0x1d670, 0x1d68a),
  fullwidth: perChar((c) => (/[!-~]/.test(c) ? cp(c.charCodeAt(0) - 0x21 + 0xff01) : c)),
  "fullwidth spaced": (s) => between(" ")(STYLES.fullwidth(s)),
  circled: perChar((c) => (/[A-Z]/.test(c) ? cp(0x24b6 + c.charCodeAt(0) - 65) : /[a-z]/.test(c) ? cp(0x24d0 + c.charCodeAt(0) - 97) : /[1-9]/.test(c) ? cp(0x2460 + Number(c) - 1) : c === "0" ? "⓪" : c)),
  "negative circled": perChar((c) => (/[a-z]/i.test(c) ? cp(0x1f150 + c.toUpperCase().charCodeAt(0) - 65) : c)),
  squared: perChar((c) => (/[a-z]/i.test(c) ? cp(0x1f130 + c.toUpperCase().charCodeAt(0) - 65) : c)),
  "negative squared": perChar((c) => (/[a-z]/i.test(c) ? cp(0x1f170 + c.toUpperCase().charCodeAt(0) - 65) : c)),
  parenthesized: perChar((c) => (/[a-z]/i.test(c) ? cp(0x249c + c.toLowerCase().charCodeAt(0) - 97) : /[1-9]/.test(c) ? cp(0x2474 + Number(c) - 1) : c)),
  "regional indicators": perChar((c) => (/[a-z]/i.test(c) ? `${cp(0x1f1e6 + c.toUpperCase().charCodeAt(0) - 65)} ` : c)),
  "small caps": table(az, "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ"),
  "upside-down": (s) => [...table(az, "ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz")(s)].reverse().join(""),
  superscript: table(az, "ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖqʳˢᵗᵘᵛʷˣʸᶻ"),
  cherokee: table(az, "ᎪᏰᏟᎴᏋᎦᎶᏂᎥᏠᏦᏝᎷᏁᎧᏢᏅᏒᏕᏖᏬᏉᏇᏲᎩᏃ"),
  "cjk look-alikes": table(az, "卂乃匚ᗪ乇千Ꮆ卄丨ﾌҜㄥ爪几ㄖ卩Ɋ尺丂ㄒㄩᐯ山乂ㄚ乙"),
  "yi look-alikes": table(az, "ꍏꌃꏳꀷꏂꎇꁅꀍ꒐꒻ꀘ꒒ꎭꈤꂦᖘꆰꋪꌗ꓄ꀎᐯꅏꊼꌩꁴ"),
  "thai and arabic look-alikes": table(az, "ค๒ς๔єŦﻮђเןкɭ๓ภ๏קợгรՇยשฬאץչ"),
  currency: table(az, "₳฿₵ĐɆ₣₲ⱧłJ₭Ⱡ₥₦Ø₱QⱤ₴₮ɄV₩ӾɎⱫ"),
  "greek and cyrillic look-alikes": table(az, "αв¢∂єƒgнιנкℓмησρqяѕтυνωχуz"),
  "hooks and strokes": table(az, "ȺɃȻƊɆƑƓĦƗɈƘȽMƝØƤɊɌȘŦɄƲWXɎƵ"),
  "strike-through": perChar((c) => `${c}̶`),
  underline: perChar((c) => `${c}̲`),
  "slash overlay": perChar((c) => `${c}̸`),
  "tilde overlay": perChar((c) => `${c}̴`),
  zalgo: perChar((c) => `${c}̖̀͒͡`),
  "zero-width joiners": between("‍"),
  "zero-width spaces": between("​"),
  "soft hyphens": between("­"),
  "word joiners": between("⁠"),
  "rtl override": (s) => `‮${[...s].reverse().join("")}‬`,
  "rtl isolate": (s) => `⁧${[...s].reverse().join("")}⁩`,
  "cyrillic letters mixed in": table("aceiopsxy", "асеіорѕху"),
  "leetspeak in keycaps": perChar((c) => { const d = { i: "1", e: "3", a: "4", o: "0", t: "7", s: "5" }[c]; return d ? `${d}️⃣` : c; }),
};
const SLURS = ["nigger", "faggot", "kike", "wetback", "tranny"];
const LINKS = ["uticacoin.com", "t.me/uticacoin", "x.com/uticacoin", "bit.ly/utica22", "discord.gg/utica"];

test("the allow-list styles: at least 30 generated fancy-text styles (each a real one of the generator sites)", () => {
  assert.ok(Object.keys(STYLES).length >= 30, String(Object.keys(STYLES).length));
  // every style really changes what it writes (no style is a no-op that would make the corpus pass for nothing)
  for (const [name, fn] of Object.entries(STYLES)) for (const w of [...SLURS, ...LINKS]) assert.notEqual(fn(w), w, `${name}: ${w}`);
});

test("the evasion corpus: every string of the verification and every style of 5 slurs and 5 links is flagged or blocked, none passes", () => {
  const corpus = [
    // SEC-1 residual: the verification's fancy-text strings
    "Utica welcomes 几丨ᎶᎶ乇尺丂 today", "Utica welcomes ภเﻮﻮєгร today", "Utica welcomes ₦ł₲₲ɆⱤ₴ today", "Utica welcomes ꈤ꒐ꁅꁅꏂꋪꌗ today",
    "Utica welcomes ᏁᎥᎶᎶᏋᏒ today", "Utica says ᏁᎥᎶᎶᏋᏒᏕ go home",
    // SEC-2 residual: links and handles with a space for the dot plus a path, a platform word plus a handle
    "Follow x com/uticacoin", "Join t me/uticacoin", "bit ly/utica22", "uticacoin com/buy",
  ];
  for (const [name, fn] of Object.entries(STYLES)) {
    for (const w of SLURS) corpus.push(`Utica welcomes ${fn(w)} today`);
    for (const w of LINKS) corpus.push(`Utica news at ${fn(w)} daily`);
  }
  assert.ok(corpus.length >= 10 + 30 * 10, String(corpus.length));
  const passed = [], tooLong = [];
  const tally = { flag: 0, block: 0 };
  for (const t of corpus) {
    const r = screenDescription(t, UTICA);
    if (r.result === "pass" || r.result === "error") passed.push(shown(t, r));
    else tally[r.result]++;
    // refused for its length only would prove nothing: every text is short enough to be judged on what it says
    if (r.issues.some((x) => x.code === "length")) tooLong.push(shown(t, r));
  }
  assert.deepEqual(passed, [], "none of the corpus may pass by itself");
  assert.deepEqual(tooLong, []);
  assert.equal(tally.flag + tally.block, corpus.length);
});

test("the verification's strings, one by one: why each is stopped (a slur in a style the folding reads is refused outright)", () => {
  const codes = (t) => new Set(screenDescription(t, UTICA).issues.map((x) => x.code));
  for (const t of ["Utica welcomes 几丨ᎶᎶ乇尺丂 today", "Utica welcomes ภเﻮﻮєгร today", "Utica welcomes ₦ł₲₲ɆⱤ₴ today", "Utica welcomes ꈤ꒐ꁅꁅꏂꋪꌗ today", "Utica welcomes ᏁᎥᎶᎶᏋᏒ today"]) {
    assert.equal(screenDescription(t, UTICA).result, "flag", t);
    assert.ok(codes(t).has("characters"), t);
  }
  for (const t of ["Follow x com/uticacoin", "Join t me/uticacoin", "bit ly/utica22", "uticacoin com/buy"]) {
    assert.equal(screenDescription(t, UTICA).result, "flag", t);
    assert.ok(codes(t).has("link_like"), t);
  }
  // without the slash too: a space for the dot, a platform word and a handle
  for (const t of ["Visit uticacoin com for the news", "Follow us on X uticacoin", "Join telegram uticacoin", "Find us at visitutica online",
    "News on Twitter every day", "DM me for the details", "Find the coin at utica22", "Go to uticacoin net today", "Bit ly utica now", "Our page is t me utica"]) {
    const r = screenDescription(t, UTICA);
    assert.notEqual(r.result, "pass", shown(t, r));
    assert.ok(r.issues.some((x) => x.code === "link_like" || x.code === "link" || x.code === "contact"), shown(t, r));
  }
  // a slur the folding still reads (mathematical letters, full-width, circled, accents below, leetspeak) is BLOCKED, not only flagged
  for (const t of ["Utica welcomes 𝐧𝐢𝐠𝐠𝐞𝐫 today", "Utica welcomes ｎｉｇｇｅｒ today", "Utica welcomes ⓝⓘⓖⓖⓔⓡ today", "Utica welcomes ṇịg̣g̣ẹṛ today", "Utica welcomes n1gg3r today"]) {
    assert.equal(screenDescription(t, UTICA).result, "block", t);
  }
});

test("names are screened with the same allow-list (the reviewer sees the flag; a slur still refuses the name)", () => {
  assert.equal(screenName("Utica Coin", UTICA).result, "pass");
  assert.equal(screenName("ᏌᏘᏆᏟᎪ Coin", UTICA).result, "flag");
  assert.equal(screenName("几丨ᎶᎶ乇尺 Town", UTICA).result, "flag");
  assert.equal(screenName("𝐔𝐭𝐢𝐜𝐚 Coin", UTICA).result, "flag");
  assert.equal(screenName("Nigger Town", UTICA).result, "block");
});

test("ordinary descriptions in English and in the city's own script still pass by themselves", () => {
  const english = [
    "Utica is the Handshake City, home of the half moon cookie and chicken riggies.",
    "Founded in 1797 on the Mohawk River, Utica grew with the Erie Canal.",
    "A coin for the people of Utica: neighbours, makers and the 1st snow of the year!",
    "Utica's parks, its old mills and its friendly corner shops (and the best tomato pie).",
    "Proud of Utica, New York. Come for the falls; stay for the food.",
    "Our city has 65,000 people, 2 rivers and \"the greatest\" bakeries - ask anyone.",
    "We love Utica — its music, its art and its 1990s diners… and its cookies.",
    "Pairs with $SOL. This is $UTICA, the city coin of Utica; 100% local pride.",
    "Uticans meet downtown every Friday; join Uticans at the market.",
    "Utica\nThe Handshake City\nSince 1797",
  ];
  for (const t of english) { const r = screenDescription(t, UTICA); assert.equal(r.result, "pass", shown(t, r)); }
  // registry cities whose own names carry their script's letters (the context the founder's routes give: src/coindefaults.js)
  const own = [
    [{ name: "Hải Dương", region: "Hai Duong", countryName: "Vietnam", country: "VN" }, "HAIDUONG", "Hải Dương là thành phố của những người bạn tốt, với món bánh gai nổi tiếng."],
    [{ name: "Buôn Ma Thuột", region: "Dak Lak", countryName: "Vietnam", country: "VN" }, "BMT", "Buôn Ma Thuột: thủ phủ cà phê của Việt Nam."],
    [{ name: "Łódź", region: "Łódź Voivodeship", countryName: "Poland", country: "PL" }, "LODZ", "Łódź to miasto włókniarzy, filmu i murali. Zapraszamy!"],
    [{ name: "Kraków", region: "Lesser Poland", countryName: "Poland", country: "PL" }, "KRAKOW", "Kraków – dawna stolica Polski, Wawel i obwarzanki."],
    [{ name: "Ağdaş", region: "Agdas", countryName: "Azerbaijan", country: "AZ" }, "AGDAS", "Ağdaş şəhərinin sikkəsi: nar bağları və gözəl insanlar."],
    [{ name: "Köln", region: "North Rhine-Westphalia", countryName: "Germany", country: "DE" }, "KOLN", "Köln am Rhein: Dom, Karneval und „Kölsch“. Für alle Kölner."],
    [{ name: "Zürich", region: "Zurich", countryName: "Switzerland", country: "CH" }, "ZURICH", "Zürich, die Stadt am See – für alle, die hier leben."],
    [{ name: "São Paulo", region: "São Paulo", countryName: "Brazil", country: "BR" }, "SAOPAULO", "São Paulo é a maior cidade do Brasil. Ninguém dorme aqui!"],
    [{ name: "Brasília", region: "Federal District", countryName: "Brazil", country: "BR" }, "BRASILIA", "Brasília, a 1ª capital planejada: ¿e você, já veio?"],
    [{ name: "Herāt", region: "Herat", countryName: "Afghanistan", country: "AF" }, "HERAT", "Herāt, the old city of gardens and poets."],
    [{ name: "Biel/Bienne", region: "Bern", countryName: "Switzerland", country: "CH" }, "BIEL", "Biel/Bienne: zwei Sprachen, eine Stadt. Deux langues, une ville."],
    // cities named in other scripts: the city's own script passes (with Basic Latin A to Z too)
    [{ name: "Москва", region: "Москва", countryName: "Россия", country: "RU" }, "MOSCOW", "Москва — столица России. Moscow, the capital, 12 million people."],
    [{ name: "Αθήνα", region: "Αττική", countryName: "Ελλάδα", country: "GR" }, "ATHENS", "Η Αθήνα είναι η πρωτεύουσα της Ελλάδας."],
    [{ name: "東京", region: "東京都", countryName: "日本", country: "JP" }, "TOKYO", "東京は日本の首都です。ようこそ、Tokyo!"],
    [{ name: "กรุงเทพมหานคร", region: "กรุงเทพมหานคร", countryName: "ประเทศไทย", country: "TH" }, "BANGKOK", "กรุงเทพมหานคร เมืองหลวงของประเทศไทย"],
    [{ name: "القاهرة", region: "القاهرة", countryName: "مصر", country: "EG" }, "CAIRO", "القاهرة هي عاصمة مصر، مدينة الألف مئذنة."],
  ];
  for (const [city, ticker, t] of own) { const r = screenDescription(t, { city, ticker }); assert.equal(r.result, "pass", `${city.name}: ${shown(t, r)}`); }
  // ...but another city's script is not plain for Utica (a person looks), and a fancy alphabet is not plain anywhere
  assert.equal(screenDescription("Москва — столица России.", UTICA).result, "flag");
  assert.equal(screenDescription("东京 welcomes 几丨ᎶᎶ乇尺丂 today", { city: { name: "东京", region: "东京", countryName: "中国", country: "CN" }, ticker: "TOKYO" }).result, "flag");
});

// The two fonts the city-coin picture is drawn with (src/coinart.js, src/coinart-wasm.js): Space Grotesk Bold (the ticker) and
// Medium (the city line and "VICINITY CITY"), SIL Open Font License 1.1 (src/assets/fonts/OFL.txt; the font declares no Reserved
// Font Name, so the subsets keep their name).
//
//   node scripts/coin-art/fonts.mjs --check            the committed files' SHA-256 equal FONT_SHA256 in src/coinart.js (no Python needed)
//   node scripts/coin-art/fonts.mjs <SpaceGrotesk[wght].ttf> [--python python3]
//                                                      rebuilds both files from the upstream variable font (needs Python 3 with
//                                                      fontTools 4.67.0: pip install fonttools==4.67.0), then prints their SHA-256
//
// Why static instances: resvg draws a variable font at its default instance (weight 300 here), whatever font-weight asks for, so
// the weights are cut out of the variable font first (fontTools varLib.instancer). Why no layout features: without kerning or
// ligatures every glyph advances by its own width, so the width table src/coinart-metrics.js (scripts/coin-art/metrics.mjs) is
// exactly what resvg draws, and the text fitting in src/coinart.js can be computed without a renderer (in the browser, the Worker
// and the tests alike). The subset keeps Basic Latin, Latin-1, Latin Extended-A/B, the combining marks and Latin Extended
// Additional (every letter of the 8,030 city names once upper-cased, except three that src/coinart.js artText draws without
// their mark), and the curly apostrophes.
//
// The upstream file: https://github.com/google/fonts/raw/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf (also in
// floriankarsten/space-grotesk, fonts/ttf), version 2.000, 136,676 bytes, SHA-256 below. Changing either output file is a new
// template version (src/coinart.js TEMPLATES): a launched coin's picture never changes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FONT_SHA256 } from "../../src/coinart.js";

export const UPSTREAM_SHA256 = "acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72";
export const FONT_FILES = { bold: "src/assets/fonts/SpaceGrotesk-Bold.ttf", medium: "src/assets/fonts/SpaceGrotesk-Medium.ttf" };
const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");

// The exact program (fontTools 4.67.0). recalcTimestamp=False keeps head.modified from the upstream file, so the output is the same
// bytes on every run and every machine.
const PY = String.raw`
import sys, hashlib
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset
src, upstream, out_bold, out_medium = sys.argv[1:5]
data = open(src, "rb").read()
if hashlib.sha256(data).hexdigest() != upstream: sys.exit("not the upstream Space Grotesk variable font (SHA-256 differs)")
unicodes = list(range(0x20, 0x7F)) + list(range(0xA0, 0x250)) + list(range(0x300, 0x370)) + list(range(0x1E00, 0x1F00)) + [0x2018, 0x2019]
for wght, dst in ((700, out_bold), (500, out_medium)):
    font = TTFont(src, recalcTimestamp=False)
    inst = instancer.instantiateVariableFont(font, {"wght": wght}, updateFontNames=True)
    o = subset.Options()
    o.layout_features = []
    o.notdef_outline = True
    o.name_IDs = ["*"]
    o.drop_tables += ["DSIG", "STAT"]
    s = subset.Subsetter(o)
    s.populate(unicodes=unicodes)
    s.subset(inst)
    inst.recalcTimestamp = False
    subset.save_font(inst, dst, o)
`;

function check() {
  let ok = true;
  for (const [k, p] of Object.entries(FONT_FILES)) {
    const got = sha(readFileSync(root(p)));
    const want = FONT_SHA256[k];
    console.log(`${got === want ? "ok  " : "FAIL"} ${p} ${got}${got === want ? "" : ` (src/coinart.js FONT_SHA256.${k} is ${want})`}`);
    ok &&= got === want;
  }
  return ok;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args[0] === "--check" || !args.length) process.exit(check() ? 0 : 1);
  const py = args.includes("--python") ? args[args.indexOf("--python") + 1] : "python3";
  const r = spawnSync(py, ["-c", PY, args[0], UPSTREAM_SHA256, root(FONT_FILES.bold), root(FONT_FILES.medium)], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
  for (const [k, p] of Object.entries(FONT_FILES)) console.log(k, p, sha(readFileSync(root(p))));
  console.log("Now set FONT_SHA256 in src/coinart.js, run node scripts/coin-art/metrics.mjs, and make a new template version.");
}

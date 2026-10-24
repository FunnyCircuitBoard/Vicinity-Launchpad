# Citycoin.dev brand assets

The logo family and Civic Atlas design tokens for Citycoin.dev, built under master change order v5 (23 Oct 2026),
sections 09 DS-01, 10 DS-02, 11 DS-03 and 12 DS-04, for acceptance checks V01, V02, V04 and V06.

Status, plainly:

- The files exist in `public/brand/`. **No page references them yet.** The live site still shows the Vicinity mark
  (`public/index.html:14` links `/favicon.svg`; `public/logo.svg` is the Vicinity mark per `scripts/brand-png.mjs:3`).
- Wiring them into pages, the manifest, social tags, mail and wallet identity is a later rollout step (see the last section).
- The owner has not reviewed these assets yet. Nothing here has been checked in a real browser or on a real phone;
  the checks that were run are listed under "Verification".

## The family

| File | What it is | When to use it |
| --- | --- | --- |
| `citycoin-wordmark-light.svg` | Lowercase `citycoin` in navy `#0C2344` and `.dev` in gold `#F8C13A`, outlined paths, transparent | The primary identity: header and footer on light surfaces (the Civic Atlas default). Prefer it alone in narrow navigation. |
| `citycoin-wordmark-dark.svg` | `citycoin` in white `#FFFFFF`, `.dev` in gold, transparent | Header and footer on dark surfaces (`#071426`, `#102A49`, `#0C2344`). |
| `citycoin-icon.svg` | Full-color skyline-on-coin emblem: five skyline masses with one tall central tower, navy structure, teal `#00CBB6` inset faces, one gold coin with four rim cuts; transparent | Light surfaces at 24 px and larger: loader, wallet prompt, about and hero accents, the platform's avatar. |
| `citycoin-icon-dark.svg` | The same emblem with a 12-unit white outline (on the 512 grid) | Dark surfaces at 24 px and larger. Navy on the dark canvas is 1.18:1, so without the outline the building silhouettes disappear. |
| `citycoin-icon-mono.svg` | Simplified one-color silhouette in navy: three masses, a central tower with spire, a coin ring and rim; transparent gaps separate the parts | 16 to 32 px and single-color uses on light surfaces. Recolor it by changing the two `fill` values (both `#0C2344`). |
| `citycoin-icon-mono-dark.svg` | The same one-color silhouette in white `#FFFFFF` (identical geometry; added by the phase 1 check so the mono family has a dark-surface export) | 16 to 32 px and single-color uses on dark surfaces (`#071426`, `#102A49`, `#0C2344`). |
| `citycoin-lockup.svg` | Emblem left, wordmark right (emblem 1.3 times the wordmark's ink height, gap 0.75 of the `c` height) | Wide headers, documents and partner listings on light surfaces, only where the width allows both. |
| `citycoin-lockup-dark.svg` | Outlined emblem and the dark wordmark | The same, on dark surfaces. |
| `favicon.svg` | Navy rounded square (radius 104 of 512) with the simplified mark: teal skyline, gold coin | `<link rel="icon" type="image/svg+xml">`. The tile is deliberate so the icon reads on both light and dark browser tab strips. |
| `favicon.ico` | ICO with three PNG entries: 16, 32 and 48 px | Legacy `/favicon.ico` requests. |
| `favicon-16.png`, `favicon-32.png`, `favicon-48.png` | Rasters of `favicon.svg` | `<link rel="icon" type="image/png" sizes="...">`. |
| `citycoin-app-icon.svg` → `apple-touch-icon-180.png` | Opaque navy square, emblem with deep navy `#071426` structure, teal faces, gold coin | `<link rel="apple-touch-icon">` (iOS adds its own corner mask; the image has no transparency). |
| `citycoin-app-icon-rounded.svg` → `icon-192.png`, `icon-512.png` | Same emblem on a navy rounded square (radius 112 of 512), transparent corners | Web manifest icons with `"purpose": "any"`; wallet adapter app icon. |
| `citycoin-app-icon-maskable.svg` → `icon-512-maskable.png` | Full-bleed navy square, emblem scaled to 0.66 | Web manifest icon with `"purpose": "maskable"`. The farthest emblem pixel in the PNG is about 182 px from the center (182.3 px measured on pixel centers, including anti-aliased edge pixels); the safe zone radius is 204.8 px (40% of 512). |
| `og-default-1200x630.svg` → `og-default-1200x630.png` | Lockup on the light Civic Atlas canvas `#F5F7FB` with a faint map grid and a gold base line. No claims, numbers or prices. | Default `og:image` and `twitter:image`. City pages need their own cards later. |
| `tokens.css` | Civic Atlas tokens as CSS custom properties, light default, dark counterpart | See "Design tokens". |
| `vicinity-512.png` | **Not part of this family.** The old Vicinity mark, already tracked in git. | Keep it: existing coin metadata and the Meteora partner record point to it (see the rollout list). |

The SVG files are the masters. Every SVG has a `viewBox`, a `<title>` and `<desc>` referenced by `aria-labelledby`,
`role="img"`, unique element ids per file, and no scripts, `<image>`, `<text>`, `<style>`, external URLs or fonts.
Only the favicon tile, the three app icons and the social image have a background shape; everything else is transparent.

## How the marks were made

**Wordmark.** The reference's own font was not identified, and this README does not claim it was. The outlines come
from **Mulish Black (weight 900)**, Copyright 2016 The Mulish Project Authors (https://github.com/googlefonts/mulish),
licensed under the **SIL Open Font License 1.1** (http://scripts.sil.org/OFL), font version 3.603, taken from the npm
package `@fontsource/mulish` 5.3.0 (file `mulish-latin-900-normal.woff`) and converted to paths with `opentype.js`
1.3.4. Of twelve OFL heavy sans families compared against `ref-002.png` (Mulish, Figtree, Outfit, Plus Jakarta Sans,
Poppins, Lato, Nunito Sans, Red Hat Display, Urbanist, Montserrat, Kumbh Sans, League Spartan), Mulish Black matched
best when overlaid on the reference: stem 0.35 x-height (reference 0.37), round `o` 1.09 x-height wide (reference 1.08),
flat-topped `t` and straight-tailed `y`. Known difference: Mulish's `t` rises 1.32 x-heights (reference 1.23). The font was installed in a scratch folder
only; it is not a dependency of this repository, and outlined paths in a logo need no license file.

Fitting to the reference (measured from `ref-002.png` in x-heights):

| Measure | Reference | Wordmark |
| --- | --- | --- |
| `citycoin` ink width | 6.644 | 6.644 (tracking -49.0/1000 em) |
| `.dev` ink width | 3.856 | 3.856 (tracking -6.7/1000 em) |
| Gap from `n` to the dot | 0.322 | 0.322 |
| Height, ascender to descender | 1.93 | 1.90 |

In the SVG the x-height is 100 units, the ink box starts at 0,0 and the `viewBox` is `0 0 1083 191`.

**Emblem.** It was drawn as new geometry (ellipses and polygons on a 512 by 512 grid), not traced. It keeps the
reference's idea: a skyline rising from inside a gold coin seen at an angle, navy structure and teal faces. It simplifies
the reference to five masses, puts every lit face on the left (one light direction), and cuts the rim with four wide
gaps instead of the reference's many narrow ones. The emblem ink spans x 40 to 472 and y 14 to 482 of the grid.

**Simplified mark** (both mono files and the favicon): three masses separated by 22-unit gaps, a 30-unit gap above the front of the
ring, a thick ring, and an edge with four 24-unit cuts, so it still reads as a skyline on a coin at 16 px.

## Clear space and minimum sizes

- **Clear space:** keep at least the height of the lowercase `c` empty on every side, measured from the ink, not from
  the file edge. In the files that is 102 units: 0.54 times the wordmark's rendered height, and 0.41 times the light
  lockup's rendered height. For the emblem on its own, keep at least a quarter of the emblem's height.
- **Never** stretch, skew, recolor parts, add effects, re-typeset the wordmark in a live font, or place the light
  wordmark on a dark surface (use the dark file).

| Asset | Minimum on screen | Notes |
| --- | --- | --- |
| Wordmark | 96 px wide (about 17 px tall) | Navigation: 136 to 160 px wide. |
| Lockup | 140 px wide (the emblem is then about 25 px tall) | Below that, use the wordmark alone. |
| `citycoin-icon.svg` / `-dark.svg` | 24 px | Readable at 24 to 32 px; at 16 px the detail blurs, so use the favicon or mono file. |
| `citycoin-icon-mono.svg`, `citycoin-icon-mono-dark.svg`, `favicon.svg` | 16 px | Checked at 16, 24, 32 and 48 px (the white mono file at 16, 32 and 512 px on `#071426`, `#102A49` and `#0C2344`). At 16 px the gaps soften but the tower and coin remain. |

## Design tokens

`tokens.css` defines the DS-04 values as `--cc-*` custom properties (prefixed so they cannot collide with the current
variables in `public/style.css`). Light is the default on `:root`. Dark applies with `<html data-theme="dark">`, or when
the device prefers dark and the page has not set `data-theme="light"`. The file also contains:

- an 8 px spacing scale (4, 8, 16, 24, 32, 40, 48, 64 and 80 px), radii of 8, 12 and 16 px plus a pill radius, a 1 px
  border width, and a 44 px tap size (`.cc-tap`);
- a visible focus ring (`:where(:focus-visible)`, 2 px with a 2 px offset), with gold inside `.cc-on-navy` areas;
- tabular numerals for money and timers (`.cc-num`);
- a reduced-motion rule: durations drop to zero and animations and transitions are cut when the device asks for reduced motion;
- typography: the site's existing OFL UI sans Inter (self-hosted by `public/style.css:3`) with system fonts as fallback,
  16 px body, and weight 800 for display.

| Token | Light | Dark | Source |
| --- | --- | --- | --- |
| `--cc-navy` | `#0C2344` | same | DS-04 |
| `--cc-gold`, `--cc-primary` | `#F8C13A` | same | DS-04 |
| `--cc-teal`, `--cc-accent` | `#00CBB6` | same | DS-04 |
| `--cc-teal-dark` | `#007E74` | same (not for text on dark) | DS-04 |
| `--cc-canvas` | `#F5F7FB` | `#071426` | DS-04 |
| `--cc-card` | `#FFFFFF` | `#102A49` | DS-04 |
| `--cc-border` | `#DCE4EE` | `#2A4A72` | DS-04 (light); proposed here (dark) |
| `--cc-border-strong` | `#74859B` | `#6F87A6` | proposed here (control edges, 3:1 or more) |
| `--cc-text`, `--cc-heading` | `#0C2344` | `#EAF0F7` | DS-04 |
| `--cc-text-2` | `#52647A` | `#A9B8CB` | DS-04 (light); proposed here (dark) |
| `--cc-text-disabled` | `#6C7D92` | `#7D8FA8` | proposed here |
| `--cc-link` | `#007E74` | `#00CBB6` | DS-04 roles |
| `--cc-on-primary` | `#0C2344` | `#0C2344` | DS-04 (navy on gold) |
| `--cc-on-navy` | `#FFFFFF` | `#FFFFFF` | DS-04 (white on navy) |
| `--cc-focus` | `#007E74` | `#00CBB6` | proposed here |
| `--cc-focus-on-navy` | `#F8C13A` | `#F8C13A` | proposed here |
| `--cc-theme-color` | `#F5F7FB` | `#071426` | for `<meta name="theme-color">` |

### Contrast ratios

Computed with the WCAG 2.x relative-luminance formula. Text needs 4.5:1 (3:1 for large text: 24 px regular or
18.66 px bold and up). Control edges and focus indicators need 3:1. These are color-pair numbers, not a test of real
pages; V04 still needs the implemented screens tested.

**Recommended pairs, light (Civic Atlas)**

| Foreground on background | Ratio | Verdict and use |
| --- | --- | --- |
| Navy `#0C2344` on white `#FFFFFF` | 15.68:1 | All text. Body and headings on cards. |
| Navy `#0C2344` on canvas `#F5F7FB` | 14.62:1 | All text. Body and headings on the page. |
| Secondary `#52647A` on white | 6.06:1 | All text. |
| Secondary `#52647A` on canvas | 5.65:1 | All text. |
| Navy `#0C2344` on gold `#F8C13A` | 9.47:1 | All text. Primary buttons (Connect wallet). |
| White `#FFFFFF` on navy `#0C2344` | 15.68:1 | All text. Navy surfaces. |
| Gold `#F8C13A` on navy `#0C2344` | 9.47:1 | All text. Accents on navy. |
| Teal `#00CBB6` on navy `#0C2344` | 7.63:1 | All text. |
| Teal-dark `#007E74` on white | 4.96:1 | All text. Links and small teal text. |
| Teal-dark `#007E74` on canvas | 4.62:1 | All text. Links on the page background. |
| White on teal-dark `#007E74` | 4.96:1 | All text. Badges. |
| Navy on teal `#00CBB6` | 7.63:1 | All text. Teal chips and map labels. |
| Navy on border tint `#DCE4EE` | 12.22:1 | All text. |
| Secondary `#52647A` on `#DCE4EE` | 4.73:1 | All text. |
| Strong border `#74859B` on white / canvas | 3.77:1 / 3.51:1 | Control edges only (3:1 or more). Not for text. |
| Disabled `#6C7D92` on white / canvas | 4.21:1 / 3.93:1 | Disabled controls only (WCAG 1.4.3 exempts them). Large-text level if used as text; always say "unavailable" in words too. |
| Focus `#007E74` against white / canvas | 4.96:1 / 4.62:1 | Focus ring (3:1 or more). |
| Focus on navy areas: gold against navy | 9.47:1 | Focus ring in `.cc-on-navy`. |

**Recommended pairs, dark counterpart**

| Foreground on background | Ratio | Verdict and use |
| --- | --- | --- |
| Text `#EAF0F7` on canvas `#071426` | 16.10:1 | All text. |
| Text `#EAF0F7` on card `#102A49` | 12.63:1 | All text. |
| White on canvas / card (dark wordmark) | 18.47:1 / 14.49:1 | All text. |
| Secondary `#A9B8CB` on card / canvas | 7.18:1 / 9.15:1 | All text. |
| Gold on canvas / card | 11.15:1 / 8.75:1 | All text. |
| Teal `#00CBB6` on canvas / card | 8.99:1 / 7.05:1 | All text. Links and focus in dark. |
| Navy on gold (button) | 9.47:1 | All text. |
| Strong border `#6F87A6` on card / canvas | 3.93:1 / 5.01:1 | Control edges (3:1 or more). |
| Disabled `#7D8FA8` on card / canvas | 4.39:1 / 5.60:1 | Disabled controls only. |

**Pairs below 4.5:1 that are limited or not allowed**

| Foreground on background | Ratio | Rule |
| --- | --- | --- |
| Teal `#00CBB6` on white / canvas | 2.06:1 / 1.92:1 | **Not allowed** for text or control edges. Map fills and illustration only. |
| Gold `#F8C13A` on white / canvas | 1.66:1 / 1.54:1 | **Not allowed** for text. The gold `.dev` in the wordmark is a logotype, which WCAG exempts; keep the wordmark at or above its minimum size. |
| White on gold | 1.66:1 | **Not allowed** (DS-04: no white small text on gold; this pair fails at every size). |
| White on teal `#00CBB6` | 2.06:1 | **Not allowed.** |
| Teal-dark `#007E74` on dark canvas | 3.73:1 | **Large text only.** Use teal `#00CBB6` in dark. |
| Teal-dark `#007E74` on dark card | 2.92:1 | **Not allowed.** |
| Teal-dark `#007E74` on navy | 3.16:1 | **Large text only.** |
| Navy `#0C2344` on dark canvas | 1.18:1 | **Not allowed.** This is why the dark emblem has an outline. |
| Border `#DCE4EE` on white / canvas | 1.28:1 / 1.20:1 | Decorative dividers only. Never the only edge of an input or button (use `--cc-border-strong`). |
| Dark border `#2A4A72` on card / canvas | 1.60:1 / 2.04:1 | Decorative only. |
| Dark card `#102A49` on dark canvas | 1.27:1 | Cards need a border or shadow to read as separate; that edge is decorative. |

## Verification that was run

All commands ran on 24 Oct 2026 against the files now in `public/brand/`.

- **Structure:** each SVG was parsed as XML and checked for `viewBox`, `<title>`, `<desc>`, forbidden elements (`script`,
  `image`, `text`, `style`, `use`, `foreignObject`, `font`) and URLs other than the SVG namespace. None were found.
  The PNG sizes and alpha were checked: the favicons, `icon-192` and `icon-512` have transparent corners, and
  `apple-touch-icon-180`, the maskable icon and the social image are fully opaque. `favicon.ico` has three PNG
  entries (16, 32 and 48), and Pillow reads all three.
- **Visual:** the three emblem files were rendered at 16, 24, 32, 48, 180 and 512 px, the wordmarks at 100 to 720 px
  wide, the lockups at 180 to 900 px wide, and every raster at its native size and enlarged, on `#F5F7FB`, `#FFFFFF`,
  `#071426`, `#102A49`, `#0C2344`, black, and the light and dark grays of browser tab strips. The results were inspected
  by eye. The wordmark was also overlaid on `ref-002.png` at the reference's scale.
- **Rasters reproduce from the masters:** the snippet below regenerated all nine raster files byte for byte (equal
  SHA-256) from the shipped SVGs.
- **tokens.css** parses with the repository's esbuild (`node_modules/.bin/esbuild public/brand/tokens.css`) with no
  warnings.
- **Independent re-check (24 Oct 2026, phase 1 checker):** every SVG parsed again (viewBox, title, desc, role, unique
  ids, no forbidden element, no reference other than internal `url(#...)` clip paths and gradients); every SVG rendered
  with `@resvg/resvg-wasm` at 16, 32 and 512 px (wordmarks and lockups at 16 and 32 px tall and 512 px wide) on
  `#F5F7FB` and `#071426` and inspected by eye; the snippet below re-run into a scratch folder gave the same SHA-256 for
  all nine rasters; every ratio in the contrast tables recomputed with the WCAG 2.x formula (all equal when rounded to
  two decimals). As intended, the light-surface files (`citycoin-icon.svg`, `citycoin-icon-mono.svg`, the light
  wordmark and lockup) are not legible on `#071426`, and the dark wordmark is not legible on `#F5F7FB`: use each file
  only on the surface named in the table above.
- **Not run:** no browser or device test (none is available in this environment), no screen-reader check, and no
  home-screen install on iOS or Android.

### Re-exporting the rasters

The rasters are renders of the SVG masters with `@resvg/resvg-wasm` 2.6.2 (already a dependency, `package.json:21`).
After editing a master, run this from the repository root as an `.mjs` file:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const { initWasm, Resvg } = require("@resvg/resvg-wasm");
await initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
const dir = "public/brand/";
const png = (svg, w) => Buffer.from(new Resvg(readFileSync(dir + svg, "utf8"),
  { fitTo: { mode: "width", value: w }, font: { loadSystemFonts: false }, shapeRendering: 2 }).render().asPng());
const out = (name, buf) => writeFileSync(dir + name, buf);
const fav = [16, 32, 48].map((s) => [s, png("favicon.svg", s)]);
for (const [s, b] of fav) out(`favicon-${s}.png`, b);
out("apple-touch-icon-180.png", png("citycoin-app-icon.svg", 180));
out("icon-192.png", png("citycoin-app-icon-rounded.svg", 192));
out("icon-512.png", png("citycoin-app-icon-rounded.svg", 512));
out("icon-512-maskable.png", png("citycoin-app-icon-maskable.svg", 512));
out("og-default-1200x630.png", png("og-default-1200x630.svg", 1200));
// favicon.ico: an ICO directory whose three entries are the PNG files above
const head = Buffer.alloc(6 + 16 * fav.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(fav.length, 4);
let off = head.length;
fav.forEach(([s, b], i) => {
  const o = 6 + 16 * i;
  head[o] = s; head[o + 1] = s; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(b.length, o + 8); head.writeUInt32LE(off, o + 12); off += b.length;
});
out("favicon.ico", Buffer.concat([head, ...fav.map(([, b]) => b)]));
```

The generator that drew the masters (geometry and font outlining) ran in a scratch folder and is not in the
repository. Edit the SVG masters directly. To re-outline the wordmark, use Mulish Black at a font size of 196.85
units per em (x-height 100), the tracking values above, and a gap of 32.2 units before the dot.

## Left for the rollout

1. **Page head links:** replace `/favicon.svg` (`public/index.html:14`, the Vicinity mark) with the new favicon set and
   add `apple-touch-icon`, in every page the page build produces.
2. **Web manifest:** none exists today. Add one with the new name, `icon-192.png`, `icon-512.png`,
   `icon-512-maskable.png` (`"purpose": "maskable"`), theme color and background color.
3. **Social tags:** `public/index.html` has no `og:image` or `twitter:image` today. Point them to the absolute
   `og-default-1200x630.png` URL once citycoin.dev serves the site (it has no web records yet). City and country
   pages need their own cards.
4. **Theme default:** the master makes Civic Atlas (light) the default, but `public/theme.js:2` and `:25` make dark the
   default and always set `data-theme` (`public/theme.js:13`), so the `prefers-color-scheme` fallback in `tokens.css` will not apply until
   that changes. The theme colors in `public/theme.js:15` (`#F5F7FB` / `#070E19`) and `public/index.html:9`
   (`#070E19`) should become `#F5F7FB` / `#071426`.
5. **Map the tokens onto the existing styles** (`public/style.css` variables such as `--display`, `--body` and `--text`)
   so one token system drives the public site, dashboard, owner pages and /architecture (V02).
6. **Brand surfaces (V06):** header and footer (`.brand` in `public/style.css:184`), loader, wallet prompt and wallet
   adapter app identity, `public/404.html` and other error pages, notifications and mail templates, and the installed-app shell.
7. **Keep `public/brand/vicinity-512.png`:** it is the logo URL in existing coin metadata (`src/coinmeta.js:37`, the
   fallback at `src/coinmeta.js:187`) and in the Meteora partner record (`src/sol/lpadmin-ix.js:48`), and
   `scripts/mainnet-preflight.mjs:357` checks it. The master keeps legacy metadata bytes exact. New city-coin assets
   need their own new paths.
8. **Status colors** (error, warning, success, stale, confirmed) are not set by DS-04. Choose and verify them during
   component work, always with text or an icon, never color alone.
9. **Display font decision:** the tokens use Inter (already on the site) at weight 800 for display. Mulish is used only
   as logo outlines. Serving it as a web font would mean adding a new OFL font file.
10. **Not produced in this step:** the richer secondary illustration of the skyline on a coin for landing and about pages
    (DS-03), a one-color lockup, and the optional CC monogram (DS-03 says it is not the primary mark).
11. **Evidence still needed for V01, V04 and V06:** real-browser checks of the favicon in light and dark tab strips, home-screen
    installs on iOS and Android (including Android mask shapes), screenshots at 390 px and 1440 px in both themes,
    keyboard and focus checks, and the owner's review of these assets.

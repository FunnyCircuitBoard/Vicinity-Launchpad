// A small cascade for our own stylesheets on the node DOM of pagedom.js: which display, visibility or min-height an element gets from the
// top-level rules of a stylesheet, by the rules' own selectors, !important, specificity and order. Enough to run the dashboard's
// first-paint hold (style.css) and the header's rules before /api/me answers (polish.css) on a page's real markup and state, so a test
// checks what the rules DO, not how they are spelled. It is not a browser: rules inside @media / @supports are left out, and so is any
// selector it does not understand (pseudo-elements, :hover, attribute operators other than =, the + combinator), which therefore never
// match. Understood: type, *, :root, #id, .class, [attr], [attr="v"], :not(<selectors>), :has(> <compound>) / :has(<compound>), and the
// combinators " ", ">" and "~".
import { Doc, El } from "./pagedom.js";

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Splits `s` at `sep` where it is not inside parentheses or quotes. */
function splitTop(s, sep) {
  const out = []; let depth = 0, q = null, from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(from, i)); from = i + 1; }
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** One compound selector (no combinators) → its parts. Throws on anything not understood. */
function compound(src) {
  const c = { tag: null, root: false, ids: [], classes: [], attrs: [], nots: [], has: [] };
  let i = 0;
  const name = () => { const m = /^-?[A-Za-z_][\w-]*/.exec(src.slice(i)); if (!m) throw new Error(`selector: ${src}`); i += m[0].length; return m[0]; };
  const paren = () => { let d = 0; const start = i; for (; i < src.length; i++) { if (src[i] === "(") d++; else if (src[i] === ")" && --d === 0) { i++; return src.slice(start + 1, i - 1); } } throw new Error(`selector: ${src}`); };
  if (src[0] === "*") i = 1;
  else if (/[A-Za-z]/.test(src[0] || "")) c.tag = name().toUpperCase();
  while (i < src.length) {
    const ch = src[i];
    if (ch === "#") { i++; c.ids.push(name()); }
    else if (ch === ".") { i++; c.classes.push(name()); }
    else if (ch === "[") {
      const end = src.indexOf("]", i); const m = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*)?\]$/.exec(src.slice(i, end + 1));
      if (!m) throw new Error(`selector: ${src}`);
      c.attrs.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? null]); i = end + 1;
    } else if (src.startsWith(":root", i)) { i += 5; c.root = true; }
    else if (src.startsWith(":not", i)) { i += 4; c.nots.push(splitTop(paren(), ",").map(complex)); }
    else if (src.startsWith(":has", i)) {
      i += 4; const arg = paren().trim();
      const child = arg.startsWith(">");
      c.has.push({ child, sel: complex(child ? arg.slice(1).trim() : arg) });
    } else throw new Error(`selector: ${src}`);
  }
  return c;
}

/** A complex selector → [{ comb, c }] left to right (comb: the combinator to the compound on the left; null for the first). */
function complex(src) {
  const parts = []; let depth = 0, cur = "", pending = null;
  const flush = () => { if (cur.trim()) { parts.push({ comb: parts.length ? pending || " " : null, c: compound(cur.trim()) }); pending = null; } cur = ""; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (ch === ">" || ch === "~" || ch === "+")) {
      if (ch === "+") throw new Error(`selector: ${src}`);
      flush(); pending = ch; continue;
    }
    if (depth === 0 && /\s/.test(ch)) { flush(); continue; }
    cur += ch;
  }
  flush();
  if (!parts.length) throw new Error(`selector: ${src}`);
  return parts;
}

const isEl = (n) => n instanceof El && !(n instanceof Doc);
function matchCompound(el, c) {
  if (!isEl(el)) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.root && el !== el.ownerDocument.documentElement) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const [k, v] of c.attrs) if (!el.hasAttribute(k) || (v !== null && el.getAttribute(k) !== v)) return false;
  for (const list of c.nots) if (list.some((parts) => matchParts(el, parts, parts.length - 1))) return false;
  for (const h of c.has) {
    const pool = h.child ? el.children : el.descendants();
    if (!pool.some((x) => matchParts(x, h.sel, h.sel.length - 1))) return false;
  }
  return true;
}
function matchParts(el, parts, i) {
  if (!matchCompound(el, parts[i].c)) return false;
  if (i === 0) return true;
  const comb = parts[i].comb;
  if (comb === ">") return isEl(el.parentNode) && matchParts(el.parentNode, parts, i - 1);
  if (comb === "~") {
    const sibs = isEl(el.parentNode) || el.parentNode instanceof Doc ? el.parentNode.children : [];
    return sibs.slice(0, sibs.indexOf(el)).some((s) => matchParts(s, parts, i - 1));
  }
  for (let p = el.parentNode; isEl(p); p = p.parentNode) if (matchParts(p, parts, i - 1)) return true;
  return false;
}
function specificity(parts) {
  const s = [0, 0, 0];
  const add = (c) => {
    s[0] += c.ids.length; s[1] += c.classes.length + c.attrs.length + (c.root ? 1 : 0); s[2] += c.tag ? 1 : 0;
    for (const list of [...c.nots, ...c.has.map((h) => [h.sel])]) {
      const best = list.map(specificity).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
      s[0] += best[0]; s[1] += best[1]; s[2] += best[2];
    }
  };
  for (const p of parts) add(p.c);
  return s;
}

/** The top-level rules of `css` that set one of `props`, each selector it understands kept with its specificity, in source order. */
export function rulesOf(css, props = ["display", "visibility", "min-height"]) {
  const text = strip(css), out = [];
  let i = 0, order = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i); if (open < 0) break;
    const head = text.slice(i, open).trim();
    let d = 0, close = open;
    for (; close < text.length; close++) { if (text[close] === "{") d++; else if (text[close] === "}" && --d === 0) break; }
    const body = text.slice(open + 1, close);
    i = close + 1;
    if (!head || head.startsWith("@")) continue; // @media, @supports, @keyframes, @font-face: not this cascade's
    const decls = {};
    for (const decl of splitTop(body, ";")) {
      const m = /^([\w-]+)\s*:\s*([\s\S]+?)\s*(!important)?$/.exec(decl);
      if (m && props.includes(m[1])) decls[m[1]] = { value: m[2].trim(), important: Boolean(m[3]) };
    }
    if (!Object.keys(decls).length) continue;
    order++;
    for (const sel of splitTop(head, ",")) {
      let parts; try { parts = complex(sel); } catch { continue; }
      out.push({ selector: sel, parts, spec: specificity(parts), decls, order });
    }
  }
  return out;
}

/** The value of `prop` for `el` by the cascade of `rules` (rulesOf), or `initial` when no rule sets it. */
export function computed(el, rules, prop, initial) {
  // the winner: !important first, then the higher specificity, then the later rule
  const cmp = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k]; return 0; };
  let best = null;
  for (const r of rules) {
    const d = r.decls[prop];
    if (!d || !matchParts(el, r.parts, r.parts.length - 1)) continue;
    const key = [d.important ? 1 : 0, ...r.spec, r.order];
    if (!best || cmp(key, best.key) >= 0) best = { key, value: d.value };
  }
  return best ? best.value : initial;
}

/** Whether `el` matches the (complex) selector `sel`, by this file's reading of selectors. */
export const matches = (el, sel) => splitTop(sel, ",").some((s) => { const parts = complex(s); return matchParts(el, parts, parts.length - 1); });

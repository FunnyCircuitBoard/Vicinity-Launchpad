// A just-enough DOM for running public/site.js in node against a real built page (no browser). It parses the page's
// HTML into elements that keep their attributes and hidden / inert / disabled state, answers querySelector for simple
// selectors (tag, #id, .class, [attr], [attr="v"], :not(...), and descendants; anything else throws, so a new selector
// in site.js fails loudly instead of quietly matching nothing), runs events through capture and bubble, and follows
// the browser's focus rules: only a shown, enabled, focusable element outside any inert part takes the keyboard.
// press() is a key press, including the browser's own default for it (Tab moves to the next stop, Enter presses a
// button). Past the last stop the keyboard leaves the page for the browser's toolbar, shown here as focus on <body>.
// It is not a browser: how the page looks and feels is checked in real Chromium.
import vm from "node:vm";
import { readFileSync } from "node:fs";

const SITE_JS = readFileSync(new URL("../../public/site.js", import.meta.url), "utf8");
const page = (file) => readFileSync(new URL("../../public/" + file, import.meta.url), "utf8");

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, n) =>
  n[0] === "#" ? String.fromCodePoint(n[1].toLowerCase() === "x" ? parseInt(n.slice(2), 16) : Number(n.slice(1))) : ENTITIES[n] ?? all);

export function newEvent(type, init = {}) {
  return {
    type, bubbles: !["focus", "blur"].includes(type), defaultPrevented: false, stopped: false, target: null, currentTarget: null,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; },
    ...init,
  };
}

export class Target {
  constructor() { this.listeners = []; }
  addEventListener(type, fn, opts) {
    const capture = opts === true || Boolean(opts && opts.capture), once = Boolean(opts && opts.once);
    if (!this.listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) this.listeners.push({ type, fn, capture, once });
  }
  removeEventListener(type, fn, opts) {
    const capture = opts === true || Boolean(opts && opts.capture);
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
}

/** Capture from the window down, the target itself, then bubble back up (for events that bubble). */
export function dispatch(target, ev, win) {
  const path = [];
  for (let x = target; x; x = x.parentNode) path.push(x);
  path.push(win);
  ev.target = target;
  const run = (node, phase) => {
    for (const l of [...node.listeners]) {
      if (l.type !== ev.type || (phase !== "target" && l.capture !== (phase === "capture"))) continue;
      if (l.once) node.removeEventListener(l.type, l.fn, l.capture);
      ev.currentTarget = node;
      l.fn.call(node, ev);
      if (ev.stopped) return;
    }
  };
  for (let i = path.length - 1; i > 0 && !ev.stopped; i--) run(path[i], "capture");
  if (!ev.stopped) run(target, "target");
  if (ev.bubbles) for (let i = 1; i < path.length && !ev.stopped; i++) run(path[i], "bubble");
  return !ev.defaultPrevented;
}

class Text {
  constructor(data) { this.data = data; this.parentNode = null; }
  get textContent() { return this.data; }
}

export class El extends Target {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.style = { setProperty() {} };
  }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  get firstElementChild() { return this.children[0] || null; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k.toLowerCase(), String(v)); }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  flag(k, on) { if (on) this.attrs.set(k, ""); else this.attrs.delete(k); }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", String(v)); }
  get className() { return this.getAttribute("class") || ""; }
  set className(v) { this.setAttribute("class", v); }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean), set = (l) => { this.className = l.join(" "); };
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => set([...new Set([...list(), ...cs])]),
      remove: (...cs) => set(list().filter((c) => !cs.includes(c))),
      toggle: (c, on = !list().includes(c)) => { set(on ? [...new Set([...list(), c])] : list().filter((x) => x !== c)); return on; },
    };
  }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(v) { this.flag("hidden", v); }
  get inert() { return this.hasAttribute("inert"); }
  set inert(v) { this.flag("inert", v); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { this.flag("disabled", v); }
  /** Focusable without a tabindex: links with an href and form controls, like in a browser. */
  get native() { return (this.tagName === "A" && this.hasAttribute("href")) || ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(this.tagName); }
  get tabIndex() { const t = this.getAttribute("tabindex"); return t !== null && /^\s*-?\d+\s*$/.test(t) ? Number(t) : this.native ? 0 : -1; }
  set tabIndex(v) { this.setAttribute("tabindex", String(v)); }
  get dataset() {
    const attr = (k) => "data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    return new Proxy({}, {
      get: (_, k) => (typeof k === "string" && this.hasAttribute(attr(k)) ? this.getAttribute(attr(k)) : undefined),
      set: (_, k, v) => { this.setAttribute(attr(k), v); return true; },
      deleteProperty: (_, k) => { this.removeAttribute(attr(k)); return true; }, // `delete el.dataset.x`, as in a browser
    });
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { this.replaceChildren(new Text(String(v))); }
  set innerHTML(html) { this.replaceChildren(...parse(this.ownerDocument, html)); }
  append(...nodes) {
    for (const n of nodes) {
      const x = typeof n === "string" ? new Text(n) : n;
      if (x.parentNode) x.parentNode.childNodes.splice(x.parentNode.childNodes.indexOf(x), 1);
      x.parentNode = this;
      this.childNodes.push(x);
    }
  }
  prepend(...nodes) { const rest = this.childNodes; this.childNodes = []; this.append(...nodes); for (const n of rest) this.childNodes.push(n); }
  replaceChildren(...nodes) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
  /** Puts `node` right after this element (moving it from wherever it was). */
  after(node) {
    const p = this.parentNode;
    if (!p) return;
    node.remove();
    node.parentNode = p;
    p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, node);
  }
  closest(selector) { const test = selectorList(selector); for (let x = this; x && x instanceof El && !(x instanceof Doc); x = x.parentNode) if (test(x)) return x; return null; }
  /** No layout here: every element reads as at the top of the screen with no size; scrollIntoView is recorded on the document. */
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  scrollIntoView(opts) { (this.ownerDocument.scrolled ||= []).push({ el: this, opts }); }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  /** Drawn on screen: in the page, and neither it nor a parent is hidden. */
  getClientRects() {
    if (!this.isConnected) return [];
    for (let x = this; x; x = x.parentNode) if (x.hidden) return [];
    return [{}];
  }
  /** Every element under this one, in document order. */
  descendants() { const out = []; const walk = (e) => { for (const c of e.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(selector) { const test = selectorList(selector); return this.descendants().filter(test); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  dispatchEvent(ev) { return dispatch(this, ev, this.ownerDocument.defaultView); }
  focus() { this.ownerDocument.moveFocus(this); }
  blur() { if (this.ownerDocument.focused === this) this.ownerDocument.moveFocus(null); }
  click() { this.dispatchEvent(newEvent("click")); }
}

export class Doc extends El {
  constructor() { super(null, "#document"); this.ownerDocument = this; this.focused = null; this.defaultView = null; }
  get body() { return this.querySelector("body"); }
  get documentElement() { return this.children[0] || null; }
  get hidden() { return false; }
  getElementById(id) { return this.descendants().find((e) => e.id === id) || null; }
  createElement(tag) { return new El(this, tag); }
  /** What a browser lets the keyboard land on. */
  canFocus(e) {
    if (!(e instanceof El) || e === this || !(e.native || e.hasAttribute("tabindex")) || e.disabled || !e.getClientRects().length) return false;
    for (let x = e; x; x = x.parentNode) if (x.inert) return false;
    return true;
  }
  /** Like a browser: an element that is hidden, removed or made inert drops the keyboard, which falls back to <body>. */
  get activeElement() { if (this.focused && !this.canFocus(this.focused)) this.focused = null; return this.focused || this.body; }
  moveFocus(e) {
    if (e && !this.canFocus(e)) return; // focus() on something that can't take it does nothing
    const old = this.activeElement === this.body ? null : this.activeElement;
    if (old === e) return;
    this.focused = e;
    if (old) dispatch(old, newEvent("blur"), this.defaultView);
    if (e) dispatch(e, newEvent("focus"), this.defaultView);
  }
  /** The Tab stops of the page, in order (no positive tabindex on this site). */
  tabStops() { return this.descendants().filter((e) => e.tabIndex >= 0 && this.canFocus(e)); }
}

/* ---------- selectors ---------- */
function compound(src) {
  const tests = [];
  let rest = src;
  const tag = rest.match(/^(\*|[a-z][\w-]*)/i);
  if (tag) { if (tag[1] !== "*") { const t = tag[1].toUpperCase(); tests.push((e) => e.tagName === t); } rest = rest.slice(tag[0].length); }
  const part = /^(?:#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]"']*)))?\]|:not\(([^()]*)\))/;
  while (rest) {
    const m = rest.match(part);
    if (!m) throw new Error(`pagedom: unsupported selector "${src}"`);
    const [all, id, cls, attr, v1, v2, v3, not] = m;
    if (id) tests.push((e) => e.id === id);
    else if (cls) tests.push((e) => e.classList.contains(cls));
    else if (attr) { const v = v1 ?? v2 ?? v3; tests.push((e) => e.hasAttribute(attr) && (v === undefined || e.getAttribute(attr) === v)); }
    else { const inner = compound(not.trim()); tests.push((e) => !inner(e)); }
    rest = rest.slice(all.length);
  }
  return (e) => e instanceof El && !(e instanceof Doc) && tests.every((t) => t(e));
}
function complex(src) {
  const parts = src.trim().split(/\s+/).map(compound);
  return (e) => {
    if (!parts[parts.length - 1](e)) return false;
    let i = parts.length - 2;
    for (let x = e.parentNode; x && i >= 0; x = x.parentNode) if (parts[i](x)) i--;
    return i < 0;
  };
}
const selectorList = (s) => { const all = s.split(",").map(complex); return (e) => all.some((t) => t(e)); };

/* ---------- HTML ---------- */
export function parse(doc, html) {
  const top = [], stack = [];
  const add = (n) => (stack.length ? stack[stack.length - 1].append(n) : top.push(n));
  const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</gi;
  for (const [all, close, open, attrs, selfClose] of html.matchAll(token)) {
    if (all.startsWith("<!")) continue;
    if (close) {
      const i = stack.map((e) => e.tagName).lastIndexOf(close.toUpperCase());
      if (i !== -1) stack.length = i;
    } else if (open) {
      const e = new El(doc, open);
      for (const [, k, a, b, c] of attrs.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) e.setAttribute(k, decode(a ?? b ?? c ?? ""));
      add(e);
      if (!selfClose && !VOID.has(open.toLowerCase())) stack.push(e);
    } else add(new Text(decode(all)));
  }
  return top;
}

/**
 * openPage("connect.html", { agreed, focus }) -> { doc, window, $, $$, press, storage }
 *   agreed  what localStorage already holds for "vicinity_terms" (a returning visitor), or null for a first visit
 *   focus   a selector to put the keyboard on before site.js runs (something already focused when the gate opens)
 * Runs public/site.js on the page, then lets its first requests (/api/me, /api/official, /api/health) answer.
 */
export async function openPage(file, { agreed = null, focus = null } = {}) {
  const doc = new Doc();
  doc.append(...parse(doc, page(file)));
  const storage = new Map(agreed ? [["vicinity_terms", agreed]] : []);
  const win = new Target();
  Object.assign(win, {
    document: doc,
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", maxTouchPoints: 0 },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    URLSearchParams,
    fetch: async (path) => {
      const body = String(path).startsWith("/api/me") ? { ok: true, signedIn: false } : { ok: true };
      return { ok: true, status: 200, json: async () => body };
    },
    CustomEvent: function CustomEvent(type, init) { return newEvent(type, { detail: init && init.detail }); },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, console,
  });
  win.window = win;
  win.addEventListener = Target.prototype.addEventListener.bind(win);
  win.removeEventListener = Target.prototype.removeEventListener.bind(win);
  doc.defaultView = win;
  if (focus) doc.querySelector(focus).focus();
  vm.runInContext(SITE_JS, vm.createContext(win), { filename: "public/site.js" });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  /** One key press: the page's own handlers first, then (unless one called preventDefault) what the browser does with it. */
  function press(key, { shift = false } = {}) {
    const at = doc.activeElement;
    const ev = newEvent("keydown", { key, shiftKey: shift });
    dispatch(at, ev, win);
    if (ev.defaultPrevented) return ev;
    if (key === "Enter" && (at.tagName === "BUTTON" || (at.tagName === "A" && at.hasAttribute("href")))) at.click();
    if (key === "Tab") {
      const stops = doc.tabStops(), all = doc.descendants(), here = all.indexOf(at);
      const after = stops.filter((e) => all.indexOf(e) > here), before = stops.filter((e) => all.indexOf(e) < here);
      const next = at === doc.body ? (shift ? stops[stops.length - 1] : stops[0]) : shift ? before[before.length - 1] : after[0];
      doc.moveFocus(next || null); // nothing further: the keyboard goes to the browser's toolbar
    }
    return ev;
  }
  return { doc, window: win, $: (s) => doc.querySelector(s), $$: (s) => doc.querySelectorAll(s), press, storage };
}

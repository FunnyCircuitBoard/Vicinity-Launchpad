// A just-enough page for public/signup.js's controller to run in node (no browser): every selector gives back ONE fake element that
// remembers its text, hidden / disabled state and handlers, so a test can type, tap and read what the page would show. It is not a DOM:
// what it does not know it answers with a harmless stand-in. The real pages are checked in a real browser (see the end-to-end notes);
// this is for regressions in what the controller DOES (which request, which message, where the keyboard is), which needs no layout.
import vm from "node:vm";
import { readFileSync } from "node:fs";

const SIGNUP_JS = readFileSync(new URL("../../public/signup.js", import.meta.url), "utf8");

export const EMPTY_STATE = () => ({ terms: { done: false, version: "2026-10-01" }, location: { done: false }, account: { done: false }, wallet: { done: false }, next: "location" });

/**
 * page({ api, mode, providers, isMobile, inApp, wallets, state }) -> { $, ctrl, doc, calls, shown, flush, ready }
 *   api(path, body)  the server's answer for one call (a plain object; _status is added); every call is recorded in `calls`
 *   state            what GET /api/signup/state answers (default: nothing done yet)
 */
export async function page({ api, mode = "", providers = { google: true, email: true }, isMobile = false, inApp = false, wallets = [], state = EMPTY_STATE(), me = {} } = {}) {
  const calls = [], shown = [], timers = [], delays = [], assigned = [];
  const doc = { activeElement: null, body: { tag: "body" }, hidden: false, addEventListener() {} };
  doc.activeElement = doc.body;
  const els = new Map();
  function fakeEl(sel) {
    const handlers = {};
    let disabled = false;
    const e = {
      sel, hidden: false, textContent: "", value: "", checked: false, type: "text", tagName: /^#.*(email|code|pw|link)$/.test(sel) ? "INPUT" : "DIV", dataset: {}, attrs: {},
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      get disabled() { return disabled; },
      set disabled(v) { disabled = Boolean(v); if (disabled && doc.activeElement === e) doc.activeElement = doc.body; }, // a disabled button loses the keyboard, like in Chrome
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      fire(type, extra = {}) { return Promise.all((handlers[type] || []).map((f) => f({ preventDefault() {}, target: e, currentTarget: e, ...extra }))); },
      setAttribute(k, v) { e.attrs[k] = String(v); }, removeAttribute(k) { delete e.attrs[k]; }, getAttribute(k) { return e.attrs[k]; },
      focus() { doc.activeElement = e; }, append() {}, replaceChildren() {}, select() {}, scrollIntoView() {}, contains() { return false; },
      closest() { return $("closest:" + sel); }, querySelector(s) { return $(sel + " " + s); }, getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
      get firstElementChild() { return $(sel + " >first"); },
    };
    return e;
  }
  const $ = (sel) => { if (!els.has(sel)) els.set(sel, fakeEl(sel)); return els.get(sel); };
  const win = {
    addEventListener() {}, V: {
      $, $$: () => [], el: (tag) => fakeEl(tag), toast() {}, copy() {}, burst() {}, getLocation: async () => ({ lat: 43.1, lon: -75.23 }), webView: false, reduced: true,
      api: async (path, body) => { // the state call is answered here, everything else by the test
        calls.push({ path, body });
        await null; // a real request takes a moment: two taps in a row both get in before the first answer
        const d = path === "/api/signup/state" ? { ok: true, state } : await api(path, body);
        return { _status: d && d.ok === false ? 400 : 200, ...d };
      },
    },
    VW: { inWalletApp: () => inApp, isMobile, list: () => wallets, onChange() {} },
  };
  const ctx = vm.createContext({
    window: win, document: doc,
    location: { origin: "https://vicinity.test", pathname: "/connect", assign: (to) => assigned.push(to), reload() {} }, history: { replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null },
    setTimeout: (fn, ms) => { timers.push(fn); delays.push(ms); return timers.length; }, clearTimeout() {},
  });
  vm.runInContext(SIGNUP_JS, ctx);
  const panel = $("#connect-panel");
  let ctrl;
  const show = (s) => { shown.push(s); ctrl.onShow(s); };
  const options = { panel, params: new URLSearchParams(mode ? `mode=${mode}` : ""), show, setErr() {}, renderPick: () => ctrl.onShow("pick"), drawQR() {}, showProof() {} };
  ctrl = win.VSignup.start(options);
  await ctrl.init({ providers, ...me });
  /** Run the timers the page asked for (a minute of "Send a new code (30s)" ticks and so on), at most `n` rounds. */
  const flush = async (n = 200) => { for (let i = 0; i < n && timers.length; i++) { timers.shift()(); await null; } };
  return { $, ctrl, doc, calls, shown, flush, win, timers, delays, assigned };
}

export const tap = (e) => e.fire("click");
export const submit = (e) => e.fire("submit");
export const callsTo = (p, path) => p.calls.filter((c) => c.path === path);

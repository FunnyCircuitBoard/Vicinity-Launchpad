// Dark / light theme. Loaded in <head> (not deferred), so the page never flashes the wrong theme.
// Dark by default: a first visit is dark whatever the device says (the owner, 6 Oct 2026). A theme toggle (the header's; the footer's on a
// phone) switches to light and remembers the choice on this device; a stored choice always wins. Every [data-theme-toggle] stays in step.
// Motion: nothing on the site loops any more (design v4, 12 Oct 2026), so the old "Pause animations" switch is gone; the device's
// "reduce motion" setting is the visitor's control. The choice it used to store is forgotten once, and data-motion is never set again.
(() => {
  const KEY = "vicinity-theme";
  const root = document.documentElement;
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {} };

  function apply(theme) {
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "light" ? "#F5F7FB" : "#070E19";
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.content = theme; // the browser's own canvas and controls follow the theme, never the device setting
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
      b.setAttribute("aria-pressed", String(theme === "light"));
      b.setAttribute("aria-label", theme === "light" ? "Switch to dark mode" : "Switch to light mode");
    });
    window.dispatchEvent(new CustomEvent("vicinity:theme", { detail: theme }));
  }

  apply(read(KEY) === "light" ? "light" : "dark");

  // the retired "Pause animations" choice: forgotten once (nothing reads it any more)
  try { localStorage.removeItem("vicinity-motion"); } catch {}

  // What this browser remembers, set before the first paint, so a page can hold the room of what it will show while it asks the server:
  //   data-guest      it has never shown a signed-in page here (site.js remembers one, and so does the tabbed dashboard): the signed-out
  //                   dashboard's room, the header's Sign up (style.css)
  //   data-returning  it has: the dashboard's public roles wait for the answer (style.css), so a member's first paint is never them
  //   data-dash-v2    its last visit was the tabbed dashboard (dashboard.js's key): its placeholders show from the first paint
  // Storage that cannot be read sets none of them: today's page, nothing held back (a first visit as far as anyone can tell).
  try {
    const member = localStorage.getItem("vicinity-account") === "1", tabbed = localStorage.getItem("vicinity:dash-v2") === "1";
    if (member || tabbed) root.dataset.returning = ""; else root.dataset.guest = "";
    if (tabbed) root.dataset.dashV2 = "";
  } catch {}

  // The dashboard's first-paint hold (style.css: #dash-out.is-pending) ends when dashboard.js has the answer. If that never comes (a script
  // that did not load or threw, an answer that never arrives), it ends here anyway: the roles show (today's page) and the placeholders go,
  // never a screen of placeholders or a blank page that stays. dashboard.js carries on if it can: a late answer still opens the dashboard,
  // straight from the roles (it never raises the placeholders again once the hold is given up). The same file sets the hold and its way
  // out, so one never runs without the other.
  // The header holds too (polish.css: a returning browser keeps the avatar's room and no Log in until site.js has the answer); if site.js
  // did not load or threw, or the answer never comes, Log in shows here and the room goes, unless site.js has decided (Log in shown, or
  // hidden for a member's avatar).
  // The clock: HOLD_MS from DOMContentLoaded, when every deferred script has run and dashboard.js has asked /api/me, so it counts the
  // answer alone (the server's own reads may take its 8 s RPC budget), never a slow network's download of the page's scripts; CAP_MS from
  // here for scripts that never finish loading (DOMContentLoaded waits for them; one that fails is caught at once below). A page brought
  // back by Back while still held starts the clock again: the answer it was waiting for can still land (dashboard.js lets go itself when
  // it leaves for /connect).
  const HOLD_MS = 12000, CAP_MS = 20000;
  const unhold = () => {
    const out = document.getElementById("dash-out");
    if (!out || !out.classList.contains("is-pending")) return; // not the dashboard, or it has decided
    out.classList.remove("is-pending");
    const skel = document.getElementById("dash-skel");
    if (skel) skel.hidden = true;
  };
  const unholdHeader = () => {
    if (root.hasAttribute("data-guest")) return; // nothing held: Log in from the first paint
    const login = document.querySelector("[data-account]"), av = document.querySelector("[data-account-avatar]");
    if (!login || !av || login.hidden || login.classList.contains("is-shown") || !av.hidden || av.classList.contains("is-off")) return; // site.js has decided
    login.classList.add("is-shown"); av.classList.add("is-off");
  };
  const giveUp = () => { unhold(); unholdHeader(); };
  const siteJs = (url) => /\/site\.js(?:[?#]|$)/.test(String(url || ""));
  // an error thrown by a script (on the window itself), or a script that did not load (its element's error reaches the window only in
  // the capture phase); a picture that did not load is not a reason. The header gives up only when it is site.js's own
  window.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && t.tagName !== "SCRIPT") return;
    unhold();
    if (t && t !== window ? siteJs(t.src || t.getAttribute("src")) : siteJs(e.filename)) unholdHeader();
  }, true);
  window.addEventListener("unhandledrejection", unhold);
  let clock = 0; // the clock that counts now (a later wait replaces an earlier one)
  const wait = (ms) => { const mine = ++clock; setTimeout(() => { if (mine === clock) giveUp(); }, ms); };
  wait(CAP_MS);
  window.addEventListener("pageshow", (e) => { if (e.persisted) wait(HOLD_MS); });

  document.addEventListener("DOMContentLoaded", () => {
    wait(HOLD_MS); // the page's scripts have run: the answers are on their way
    apply(root.dataset.theme);
    document.querySelectorAll("[data-theme-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const next = root.dataset.theme === "light" ? "dark" : "light";
        write(KEY, next);
        apply(next);
      }));
  });
})();

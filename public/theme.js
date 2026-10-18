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

  // A guest: this browser has never shown a signed-in page here (site.js remembers one, and so does the tabbed dashboard). Set before
  // the first paint, so a page can hold the room of what a guest will see while it asks the server (style.css: the signed-out dashboard,
  // the header's Sign up).
  try { if (localStorage.getItem("vicinity-account") !== "1" && localStorage.getItem("vicinity:dash-v2") !== "1") root.dataset.guest = ""; } catch {}
  // Someone whose last visit here was the tabbed dashboard (dashboard.js's key): its placeholders show from the first paint (style.css),
  // not once dashboard.js has run, so a returning member never sees the public rules at the top of the page first
  try { if (localStorage.getItem("vicinity:dash-v2") === "1") root.dataset.dashV2 = ""; } catch {}

  document.addEventListener("DOMContentLoaded", () => {
    apply(root.dataset.theme);
    document.querySelectorAll("[data-theme-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const next = root.dataset.theme === "light" ? "dark" : "light";
        write(KEY, next);
        apply(next);
      }));
  });
})();

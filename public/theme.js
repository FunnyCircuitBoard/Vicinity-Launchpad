// Dark / light theme, and the visitor's "Pause animations" choice. Loaded in <head> (not deferred), so the page never flashes the
// wrong theme and a paused page never starts moving.
// Dark by default: a first visit is dark whatever the device setting says (the owner, 6 Oct 2026). The header toggle switches to
// light and remembers the choice on this device; a stored choice always wins.
(() => {
  const KEY = "vicinity-theme", MOTION = "vicinity-motion";
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

  // "Pause animations" (footer, every page): stops every looping animation of the site at once (WCAG 2.2.2), remembered on this
  // device. style.css stops them under :root[data-motion="paused"]; site.js treats it like a reduced-motion setting.
  function motion(paused) {
    if (paused) root.dataset.motion = "paused"; else delete root.dataset.motion;
    document.querySelectorAll("[data-motion-toggle]").forEach((b) => { b.textContent = paused ? "Play animations" : "Pause animations"; });
  }
  motion(read(MOTION) === "paused");

  // A guest: this browser has never shown a signed-in page here (site.js remembers one, and so does the tabbed dashboard). Set before
  // the first paint, so a page can hold the room of what a guest will see while it asks the server (style.css: the signed-out dashboard).
  try { if (localStorage.getItem("vicinity-account") !== "1" && localStorage.getItem("vicinity:dash-v2") !== "1") root.dataset.guest = ""; } catch {}

  document.addEventListener("DOMContentLoaded", () => {
    apply(root.dataset.theme);
    motion(root.dataset.motion === "paused");
    document.querySelectorAll("[data-theme-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const next = root.dataset.theme === "light" ? "dark" : "light";
        write(KEY, next);
        apply(next);
      }));
    document.querySelectorAll("[data-motion-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const paused = root.dataset.motion !== "paused";
        write(MOTION, paused ? "paused" : null);
        motion(paused);
        window.dispatchEvent(new CustomEvent("vicinity:motion", { detail: paused ? "paused" : "on" }));
      }));
  });
})();

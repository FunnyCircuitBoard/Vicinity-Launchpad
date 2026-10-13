// The app preview (/app, design v4): the first button's label (Sign up, or My dashboard for a member), the dots under the phones on a
// phone or tablet (which screen is in view), and the middle phone's small lean toward a mouse on a computer. Nothing here loops: the
// lean follows the pointer (one frame per move at most) and settles back when it leaves; with reduced motion it never runs.
(() => {
  "use strict";
  const { $, $$ } = window.V;

  /* "Sign up" for a guest, "My dashboard" for a member: both labels are in the button (pages-app.css shows one); /api/me corrects the
     first-paint guess only when it was wrong, and the link goes where the label says */
  const first = $("[data-app-first]");
  if (first && !("guest" in document.documentElement.dataset)) first.href = "/dashboard";
  window.V.ready.then((d) => {
    if (!first) return;
    const yes = Boolean(d && d.signedIn);
    first.classList.toggle("is-member", yes); first.classList.toggle("is-guest", !yes);
    first.href = yes ? "/dashboard" : "/connect";
  });

  /* the dots: the phone most in view of the strip is the bright one; hidden (their room kept) while all three fit */
  const strip = $("#app-phones"), dots = $$(".app4-dots span"), figs = $$(".app4-fig");
  if (strip && dots.length === figs.length && window.IntersectionObserver) {
    const seen = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target, e.intersectionRatio);
      let best = 0, at = 0;
      figs.forEach((f, i) => { const r = seen.get(f) || 0; if (r > best) { best = r; at = i; } });
      dots.forEach((d, i) => d.classList.toggle("is-on", i === at));
    }, { root: strip, threshold: [0, 0.25, 0.5, 0.75, 1] });
    figs.forEach((f) => io.observe(f));
    const box = dots[0].parentElement;
    // while the strip scrolls (a phone, a tablet) it is a Tab stop, so a keyboard can scroll it (Safari does not focus a scroller itself);
    // a computer's fanned-out phones do not scroll (overflow visible): no Tab stop there
    const fit = () => {
      const all = strip.scrollWidth <= strip.clientWidth + 1; box.classList.toggle("is-off", all);
      if (all || getComputedStyle(strip).overflowX === "visible") strip.removeAttribute("tabindex"); else strip.tabIndex = 0;
    };
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(strip);
  }

  /* the middle phone leans up to 4° toward a mouse over the phones (a computer, motion welcome): transform only, one frame per move */
  const tilt = $("[data-tilt]"), stage = $(".app4-stage");
  const fine = window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 1024px)");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (tilt && stage) {
    let frame = 0, x = 0, y = 0;
    const put = () => { frame = 0; tilt.style.transform = `perspective(1200px) rotateY(${(x * 4).toFixed(2)}deg) rotateX(${(-y * 3).toFixed(2)}deg)`; };
    stage.addEventListener("pointermove", (e) => {
      if (!fine.matches || still.matches || e.pointerType !== "mouse") return;
      const r = stage.getBoundingClientRect();
      x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      if (!frame) frame = requestAnimationFrame(put);
    });
    stage.addEventListener("pointerleave", () => { cancelAnimationFrame(frame); frame = 0; tilt.style.transform = ""; });
    still.addEventListener("change", () => { if (still.matches) tilt.style.transform = ""; });
  }
})();

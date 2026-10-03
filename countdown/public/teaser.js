// Vicinity countdown (vicinitycity.com): the clock, the rotating lines, "Rep your city" (answers go to this
// site's own /api/answers), the live board (/api/pulse), "add to calendar", "share on X", and the night sky
// of city lights. Nothing is loaded from any other website.
(() => {
  "use strict";
  const LAUNCH = Date.parse("2026-10-03T15:10:00-04:00"); // Saturday, October 3, 2026, 3:10 PM New York time
  const X = "https://x.com/VicinityCitySOL";
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(pointer: fine)").matches;
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (n) => Number(n).toLocaleString();
  const regions = (() => { try { return new Intl.DisplayNames([navigator.language || "en"], { type: "region" }); } catch { return null; } })();
  const country = (cc) => { try { return (regions && regions.of(cc)) || cc; } catch { return cc; } };
  const store = {
    get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
  };
  async function api(path, body) {
    try {
      const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && d.ok === undefined) d.ok = false;
      return d;
    } catch { return { ok: false, error: "offline" }; }
  }
  const intent = (text) => `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent("https://vicinitycity.com/rep")}&via=VicinityCitySOL`;

  /* ---------- the countdown ---------- */
  const last = {};
  let riddleTimer = 0;
  function tick() {
    const ms = Math.max(0, LAUNCH - Date.now());
    const parts = { days: Math.floor(ms / 864e5), hours: Math.floor((ms % 864e5) / 36e5), minutes: Math.floor((ms % 36e5) / 6e4), seconds: Math.floor((ms % 6e4) / 1e3) };
    for (const [k, v] of Object.entries(parts)) {
      const e = $(`[data-u="${k}"]`), txt = pad(v);
      if (last[k] === txt) continue;
      e.textContent = txt;
      if (!reduced && last[k] !== undefined) { e.classList.remove("is-tick"); void e.offsetWidth; e.classList.add("is-tick"); }
      last[k] = txt;
    }
    if (ms === 0 && !document.body.classList.contains("is-live")) {
      document.body.classList.add("is-live");
      $("#status").textContent = "It's here";
      $("#title").innerHTML = '<span class="line">It’s here.</span> <span class="line accent">Your city is waiting.</span>';
      $("#riddle").textContent = "The official announcement is live on @VicinityCitySOL.";
      clearInterval(riddleTimer);
      // The countdown is over: after a moment on "It's here", go to the live site (the server sends every later visit there too).
      setTimeout(() => location.replace("https://vicinity.city/"), 1500);
    }
  }
  const when = new Date(LAUNCH);
  $("#local").textContent = `That's ${when.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} where you are.`;

  /* ---------- lines that come and go ---------- */
  const LINES = ["Every city has a secret.", "It starts where you live.", "Your neighbours will be first.", "Locals first. Always.", "3:10 PM ET. Remember it.", "Some things can't be copied."];
  let li = 0;
  const riddle = $("#riddle");
  riddleTimer = setInterval(() => {
    if (document.hidden) return;
    riddle.classList.add("is-out");
    setTimeout(() => { li = (li + 1) % LINES.length; riddle.textContent = LINES[li]; riddle.classList.remove("is-out"); }, reduced ? 0 : 450);
  }, 4200);
  tick(); setInterval(tick, 1000);

  /* ---------- rep your city ---------- */
  const ERR = {
    city_required: "Type your city to continue.",
    slow_down: "That's a lot of answers from one place. Try again in a bit.",
    too_long: "One of those answers is too long.",
    offline: "You look offline. Check your connection and try again.",
  };
  const form = $("#rep-form"), steps = $$(".step"), TOTAL = steps.length;
  const cityIn = $("#q-city"), acList = $("#q-city-list");
  const saved = store.get("vicinity.rep");
  const randomId = () => { const b = crypto.getRandomValues(new Uint8Array(18)); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const answers = { id: (saved && saved.id) || randomId(), city: "", place: null, word: "", pride: 7, wants: [], famous: "" };
  let step = 1, chosen = null, acItems = [], acIndex = -1, acTimer = 0, acSeq = 0;
  let pulse = null, youKey = saved && saved.result && saved.result.place ? saved.result.place.key : null; // the live board, and your city on it
  const cityName = () => chosen ? chosen.name : cityIn.value.trim() || "your city";
  const err = (m) => { const e = $("#rep-err"); e.textContent = m || ""; e.hidden = !m; };

  function show(n) {
    step = n;
    steps.forEach((s) => s.classList.toggle("is-on", Number(s.dataset.step) === n));
    $("#rep-bar").style.width = `${(n / TOTAL) * 100}%`;
    $("#rep-step").textContent = `${n} / ${TOTAL}`;
    $("#rep-back").hidden = n === 1;
    $("#rep-next").textContent = n === TOTAL ? "Rep my city 🔥" : "Next →";
    $("#rep-title").textContent = n === 1 ? "Where are you from?" : `Tell us about ${cityName()}.`;
    if (n > 1) $$("[data-city]").forEach((e) => (e.textContent = cityName()));
    err("");
    const f = steps[n - 1].querySelector("input.field");
    if (f && fine) f.focus({ preventScroll: true });
  }

  // city suggestions as you type
  function closeAc() { acList.hidden = true; cityIn.setAttribute("aria-expanded", "false"); cityIn.removeAttribute("aria-activedescendant"); }
  function pick(i) { chosen = acItems[i]; cityIn.value = chosen.name; closeAc(); }
  async function suggest() {
    const q = cityIn.value.trim();
    if (q.length < 2) { acItems = []; closeAc(); return; }
    const seq = ++acSeq;
    const r = await api(`/api/places?q=${encodeURIComponent(q)}`);
    if (seq !== acSeq) return;
    acItems = r.places || []; acIndex = -1;
    if (!acItems.length) { closeAc(); return; }
    acList.replaceChildren(...acItems.map((p, i) => {
      const item = document.createElement("li");
      item.id = `ac-${i}`; item.setAttribute("role", "option"); item.setAttribute("aria-selected", "false");
      const small = document.createElement("span"); small.textContent = country(p.cc);
      item.append(p.name, small);
      item.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); });
      return item;
    }));
    acList.hidden = false; cityIn.setAttribute("aria-expanded", "true");
  }
  cityIn.addEventListener("input", () => { chosen = null; clearTimeout(acTimer); acTimer = setTimeout(suggest, 140); });
  cityIn.addEventListener("keydown", (e) => {
    if (acList.hidden || !acItems.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      acIndex = (acIndex + (e.key === "ArrowDown" ? 1 : -1) + acItems.length) % acItems.length;
      [...acList.children].forEach((c, i) => c.setAttribute("aria-selected", String(i === acIndex)));
      cityIn.setAttribute("aria-activedescendant", `ac-${acIndex}`);
    } else if (e.key === "Enter" && acIndex >= 0) { e.preventDefault(); pick(acIndex); }
    else if (e.key === "Escape") closeAc();
  });
  cityIn.addEventListener("blur", () => setTimeout(closeAc, 150));

  // one word: tap a suggestion to fill it in
  $$(".chips[data-fill] button").forEach((b) => b.addEventListener("click", () => { $(`#${b.parentElement.dataset.fill}`).value = b.textContent; }));
  // pride: 1 to 10, with a face that follows
  const FACES = ["😐", "😐", "🙂", "🙂", "😊", "😊", "😎", "😎", "😍", "🔥"];
  const pride = $("#q-pride");
  const paintPride = () => {
    const v = Number(pride.value);
    $("#q-pride-out").textContent = v; $("#q-emoji").textContent = FACES[v - 1];
    pride.style.setProperty("--fill", `${((v - 1) / 9) * 100}%`);
    if (!reduced) $("#q-emoji").animate([{ transform: "scale(1.35)" }, { transform: "none" }], { duration: 250 });
  };
  pride.addEventListener("input", paintPride);
  // more of: up to 3
  const wantBtns = $$("#q-wants button");
  wantBtns.forEach((b) => b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") === "true";
    if (!on && wantBtns.filter((x) => x.getAttribute("aria-pressed") === "true").length >= 3) { err("Pick up to 3."); return; }
    err(""); b.setAttribute("aria-pressed", String(!on));
  }));

  $("#rep-back").addEventListener("click", () => show(Math.max(1, step - 1)));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (step === 1) {
      const typed = cityIn.value.trim();
      if (typed.length < 2) { err(ERR.city_required); return; }
      if (!chosen && acItems[0] && acItems[0].name.toLowerCase() === typed.toLowerCase()) chosen = acItems[0];
      if (chosen && chosen.name !== typed) chosen = null;
      closeAc();
    }
    if (step < TOTAL) { show(step + 1); return; }
    Object.assign(answers, {
      city: cityIn.value.trim(), place: chosen ? [chosen.name, chosen.cc] : null, word: $("#q-word").value.trim(),
      pride: Number(pride.value), wants: wantBtns.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.v), famous: $("#q-famous").value.trim(),
    });
    const btn = $("#rep-next");
    btn.disabled = true; btn.textContent = "Saving…";
    const r = await api("/api/answers", answers);
    btn.disabled = false;
    if (!r.ok) { btn.textContent = "Rep my city 🔥"; err(ERR[r.error] || "Couldn't save that. Please try again."); return; }
    answers.id = r.id;
    store.set("vicinity.rep", { ...answers, result: r });
    done(r, true);
    loadPulse();
  });

  function done(r, fresh) {
    form.hidden = true; $(".rep__progress").hidden = true;
    $("#rep-done").hidden = false;
    $("#rep-title").textContent = "You're on the map.";
    const name = r.city;
    $("#done-title").textContent = `You're repping ${name}.`;
    $("#done-text").textContent = r.rank
      ? `You're one of ${fmt(r.count)} from ${name}, and ${name} is #${r.rank} on the board. Bring your people.`
      : `You're one of ${fmt(r.count)} from ${name} so far. Bring your people.`;
    $("#done-share").href = intent(`I'm repping ${name} 🏙️\nSomething is coming to your city 👀 October 3 · 3:10 PM ET`);
    youKey = r.place ? r.place.key : null;
    renderBoard();
    if (fresh) confetti();
  }
  $("#rep-again").addEventListener("click", () => { $("#rep-done").hidden = true; form.hidden = false; $(".rep__progress").hidden = false; show(1); });

  // coming back: your answers are remembered on this device
  if (saved) {
    cityIn.value = saved.city || "";
    chosen = saved.place ? { name: saved.place[0], cc: saved.place[1] } : null;
    $("#q-word").value = saved.word || "";
    pride.value = saved.pride || 7;
    wantBtns.forEach((b) => b.setAttribute("aria-pressed", String((saved.wants || []).includes(b.dataset.v))));
    $("#q-famous").value = saved.famous || "";
  }
  paintPride();
  if (saved && saved.result) done(saved.result, false); else show(1);

  /* ---------- live: people waiting and the board ---------- */
  function countUp(el, to) {
    const from = Number(el.dataset.n || 0);
    el.dataset.n = to;
    if (reduced || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function renderBoard() {
    if (!pulse) return;
    const top = pulse.top || [];
    $("#board-empty").hidden = top.length > 0;
    const max = Math.max(1, ...top.map((t) => t.n));
    const rows = top.map((t, i) => {
      const row = document.createElement("li");
      if (t.key === youKey) row.className = "is-you";
      const bar = document.createElement("span"); bar.className = "board__bar";
      const rank = document.createElement("span"); rank.className = "board__rank"; rank.textContent = `#${i + 1}`;
      const city = document.createElement("span"); city.className = "board__city"; city.textContent = t.name;
      const small = document.createElement("small"); small.textContent = country(t.cc); city.append(small);
      const n = document.createElement("span"); n.className = "board__n"; n.textContent = `${fmt(t.n)} ${t.n === 1 ? "person" : "people"}`;
      if (t.pride != null) { const p = document.createElement("small"); p.textContent = `pride ${t.pride}/10`; n.append(p); }
      row.append(bar, rank, city, n);
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = `${Math.max(8, (t.n / max) * 100)}%`; }));
      return row;
    });
    $("#board-list").replaceChildren(...rows);
  }
  async function loadPulse() {
    const d = await api("/api/pulse");
    if (!d || d.ok === false) return;
    pulse = d;
    if (d.people > 0) {
      $("#live-count").hidden = false; countUp($("#lc-people"), d.people); countUp($("#lc-cities"), d.cities);
      $("#lc-pw").textContent = d.people === 1 ? "person" : "people"; $("#lc-cw").textContent = d.cities === 1 ? "city" : "cities"; $("#lc-verb").textContent = d.people === 1 ? "is" : "are";
    }
    renderBoard();
  }
  loadPulse(); setInterval(() => { if (!document.hidden) loadPulse(); }, 30000);

  /* ---------- add to calendar (a standard .ics file made right here) ---------- */
  $("#cal").addEventListener("click", () => {
    const stamp = (t) => t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Vicinity//Countdown//EN", "BEGIN:VEVENT", `UID:vicinity-${LAUNCH}@vicinitycity.com`,
      `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(when)}`, `DTEND:${stamp(new Date(LAUNCH + 30 * 60e3))}`,
      "SUMMARY:Vicinity drops", `DESCRIPTION:Something is coming to your city. Follow @VicinityCitySOL on X: ${X}`, "URL:https://vicinitycity.com/",
      "BEGIN:VALARM", "TRIGGER:-PT15M", "ACTION:DISPLAY", "DESCRIPTION:Vicinity in 15 minutes", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a");
    a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    a.download = "vicinity.ics";
    document.body.append(a); a.click(); a.remove();
  });
  $("#share").href = intent("Something is coming to your city 👀\nOctober 3 · 3:10 PM ET");

  /* ---------- feel: a light that follows you, cards that tilt, a button that leans in, sections that rise ---------- */
  const root = document.documentElement;
  let mx = innerWidth / 2, my = innerHeight / 3, spotRaf = 0;
  if (fine && !reduced) {
    addEventListener("pointermove", (e) => {
      mx = e.clientX; my = e.clientY;
      if (!spotRaf) spotRaf = requestAnimationFrame(() => { root.style.setProperty("--mx", `${mx}px`); root.style.setProperty("--my", `${my}px`); spotRaf = 0; });
    }, { passive: true });
    const tilt = (el, max) => {
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(700px) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg)`;
      });
      el.addEventListener("pointerleave", () => (el.style.transform = ""));
    };
    $$(".tilt").forEach((e) => tilt(e, 16));
    $$(".tilt-soft").forEach((e) => tilt(e, 6));
    $$(".magnet").forEach((b) => {
      b.addEventListener("pointermove", (e) => { const r = b.getBoundingClientRect(); b.style.transform = `translate(${((e.clientX - r.left - r.width / 2) * 0.18).toFixed(1)}px, ${((e.clientY - r.top - r.height / 2) * 0.3).toFixed(1)}px)`; });
      b.addEventListener("pointerleave", () => (b.style.transform = ""));
    });
  }
  if ("IntersectionObserver" in window && !reduced) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } }), { threshold: 0.12 });
    $$(".reveal").forEach((e) => io.observe(e));
  } else $$(".reveal").forEach((e) => e.classList.add("is-in"));

  function confetti() {
    if (reduced) return;
    const box = $(".rep__card").getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + 90;
    const colors = ["#FF5A36", "#FFC857", "#FFE3A3", "#7A5CFF", "#37C29A", "#FFFFFF"];
    for (let i = 0; i < 80; i++) {
      const s = document.createElement("span");
      s.className = "confetti"; s.style.background = colors[i % colors.length];
      document.body.append(s);
      const a = Math.random() * Math.PI * 2, v = 120 + Math.random() * 260;
      s.animate([
        { transform: `translate(${x}px, ${y}px) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${x + Math.cos(a) * v}px, ${y + Math.sin(a) * v * 0.6 - 120}px) rotate(${Math.random() * 540}deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${x + Math.cos(a) * v * 1.3}px, ${y + 380 + Math.random() * 200}px) rotate(${Math.random() * 900}deg)`, opacity: 0 },
      ], { duration: 1500 + Math.random() * 900, easing: "cubic-bezier(.2,.7,.4,1)" }).onfinish = () => s.remove();
    }
  }

  /* ---------- the night sky: city lights that twinkle, drift with you, and pulse now and then ---------- */
  const cv = $("#sky"), g = cv.getContext("2d");
  let W = 0, H = 0, dpr = 1, lights = [], pulses = [], raf = 0, px = 0, py = 0;
  const rnd = (a, b) => a + Math.random() * (b - a);
  function build() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // lights gather in clusters, like towns seen from the sky at night
    const clusters = Array.from({ length: Math.round(Math.max(6, (W * H) / 90000)) }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(30, 120), n: Math.round(rnd(10, 40)) }));
    lights = [];
    for (const c of clusters) for (let i = 0; i < c.n; i++) {
      const a = rnd(0, Math.PI * 2), d = Math.abs(rnd(0, 1) * rnd(0, 1)) * c.r;
      lights.push({ x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d, s: rnd(0.4, 1.6), p: rnd(0, Math.PI * 2), v: rnd(0.4, 1.4), gold: Math.random() < 0.18 });
    }
    for (let i = 0; i < (W * H) / 9000; i++) lights.push({ x: rnd(0, W), y: rnd(0, H), s: rnd(0.3, 0.8), p: rnd(0, 6.28), v: rnd(0.2, 0.8), gold: false });
  }
  function draw(t) {
    // the sky leans a little with the cursor (bigger lights are "closer" and move more)
    px += ((mx / Math.max(1, W) - 0.5) - px) * 0.04; py += ((my / Math.max(1, H) - 0.5) - py) * 0.04;
    g.clearRect(0, 0, W, H);
    for (const l of lights) {
      const a = 0.35 + 0.65 * Math.abs(Math.sin(l.p + (t / 1000) * l.v));
      const x = l.x - px * l.s * 14, y = l.y - py * l.s * 10;
      g.globalAlpha = a;
      g.fillStyle = l.gold ? "#FFC857" : "#FFE9D6";
      g.beginPath(); g.arc(x, y, l.s, 0, Math.PI * 2); g.fill();
      if (l.gold && l.s > 1.1) { g.globalAlpha = a * 0.18; g.beginPath(); g.arc(x, y, l.s * 5, 0, Math.PI * 2); g.fill(); }
    }
    // a light somewhere wakes up and sends out a ring
    if (!reduced && Math.random() < 0.012 && pulses.length < 4) { const l = lights[Math.floor(Math.random() * lights.length)]; pulses.push({ x: l.x, y: l.y, t0: t }); }
    pulses = pulses.filter((p) => t - p.t0 < 2600);
    for (const p of pulses) {
      const k = (t - p.t0) / 2600;
      g.globalAlpha = (1 - k) * 0.55; g.strokeStyle = "#FF5A36"; g.lineWidth = 1.4;
      g.beginPath(); g.arc(p.x, p.y, 6 + k * 90, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
    if (!reduced) raf = requestAnimationFrame(draw);
  }
  build(); draw(performance.now());
  let resizeTimer = 0;
  addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { cancelAnimationFrame(raf); build(); draw(performance.now()); }, 150); });
  document.addEventListener("visibilitychange", () => { cancelAnimationFrame(raf); if (!document.hidden) draw(performance.now()); });
})();

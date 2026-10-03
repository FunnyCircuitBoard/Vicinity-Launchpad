// /locate?code=…: the phone's normal browser reads GPS for a check that was started in a wallet app's browser
// (which often can't share it). The code comes from /api/locate/handoff; src/handoff.js has the rules.
(() => {
  "use strict";
  const { $, $$, api, getLocation } = window.V;
  const code = new URLSearchParams(location.search).get("code");
  const WHAT = { home: "set your home community", apply: "apply to found your city", checkin: "check in", request: "send your town request", signup: "check where you are for your new account" };
  const ERR = {
    location_unverified: "We couldn't confirm your location. Turn on precise location, use your normal mobile or home internet (no VPN) on the same phone as your wallet app, and try again.",
    expired: "This link has expired. Go back to your wallet app and start again.",
    already_done: "This link was already used. Go back to your wallet app.",
    slow_down: "That's a lot of attempts. Take a break and try again later.",
    cities_unavailable: "The map is busy. Please try again in a minute.",
    location_required: "We couldn't read your location. Please try again.",
  };
  // A sign-up check is also started from a computer, so the network advice is different: the phone must be on the same network as where it began.
  const SIGNUP_ERR = {
    location_unverified: "We couldn't confirm your location. Turn on precise location and turn off any VPN. This phone must be on the same network as the device where you started: join the computer's Wi-Fi, or use this phone's normal internet if you started in a wallet app. Then try again.",
  };
  let forSignup = false;
  const wording = (code) => (forSignup && SIGNUP_ERR[code]) || ERR[code];
  const show = (s) => $$(".cstate").forEach((x) => (x.hidden = x.dataset.state !== s));
  const bad = (msg) => { if (msg) $("#l-bad").textContent = msg; show("bad"); };

  $("#l-go").addEventListener("click", async (e) => {
    const btn = e.currentTarget, err = $("#l-error");
    err.hidden = true; btn.disabled = true; btn.textContent = "Checking your location…";
    try {
      const loc = await getLocation();
      const r = await api("/api/locate/handoff/complete", { code, location: loc });
      if (!r.ok) {
        if (r.error === "expired" || r.error === "already_done") return bad(ERR[r.error]);
        throw new Error(wording(r.error) || "Couldn't check your location. Please try again.");
      }
      $("#l-city").textContent = r.city ? `: you're in ${r.city}` : "";
      show("done");
    } catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = "Share my location"; }
  });

  /** A new account's location check can be started from a computer too, so don't say "wallet app" there. */
  function signupWording() {
    const ask = $("#l-purpose").parentElement, strong = $("#l-purpose");
    ask.replaceChildren("You started this on Vicinity to ", strong, ". Share your location here, then go back to the page where you started: it continues by itself.");
    $(".cstate[data-state=done] p").textContent = "Go back to the page where you started. It picks this up in a few seconds. You can close this page.";
    // the page's own bullet about the network is written for a wallet app on this phone: say the same thing the error would
    const net = Array.from($$(".safety li")).find((li) => /same phone as your wallet app/.test(li.textContent));
    if (net) net.textContent = "Turn off any VPN. This phone must be on the same network as the device where you started: the computer's Wi-Fi, or this phone's normal internet if you started in a wallet app.";
  }

  (async () => {
    if (!code) return bad("This link is incomplete. Go back to your wallet app and start again.");
    const info = await api("/api/locate/handoff/info", { code });
    if (!info.ok) return bad();
    if (info.done) return show("done");
    $("#l-purpose").textContent = WHAT[info.purpose] || "continue";
    if (info.purpose === "signup") { forSignup = true; signupWording(); } // it may have been started on a computer, not in a wallet app
    show("ask");
  })();
})();

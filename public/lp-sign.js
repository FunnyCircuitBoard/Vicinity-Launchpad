/**
 * Signing for the city-coin pages (admin setup and approvals, the founder's launch, "Move to the open market"): window.LP.
 * The Worker builds an UNSIGNED transaction (src/lpkit.js buildTx) and never holds a key. Some steps need one-time keys besides
 * the wallet (a Meteora price-curve config, a coin's mint, two position-NFT mints): they are made HERE with WebCrypto Ed25519,
 * NOT extractable (the page itself cannot read the private half), used for exactly one transaction, never stored, never sent;
 * only their public keys go to the Worker. Such a key has no power after its transaction (src/lpkit.js, PLAN D4).
 *
 *   LP.supported()                     -> Promise<boolean>   WebCrypto Ed25519 is there (if not: no fallback, the page explains)
 *   LP.ephemeral(n)                    -> Promise<[{ publicKey (base58), sign(bytes) -> Promise<Uint8Array(64)> }]>
 *   LP.prepare({ wallet, build, ephemeral, cluster })  -> Promise<handle>   builds; handle.response is what the page shows
 *   handle.sign({ onStatus })          -> Promise<{ signature, status, solscan }>   call it straight from the person's tap
 *   LP.run({ wallet, build, ephemeral, cluster, onSummary, onStatus })   prepare, then onSummary(response) (resolve true to go
 *                                         on, false to stop), then sign
 *   LP.renderSummary(el, response)     the decoded instruction list and the exact SOL change, in plain words (textContent only)
 *   LP.say(code, extra)                the plain-word message of an error code
 *
 * The order of signing is fixed: the ONE-TIME KEYS sign first, each at its own slot, over the exact message prepare() checked
 * (the wallet pays; the signers are exactly the wallet and those keys); the wallet's slot (0) stays empty. Then the wallet:
 *   - a wallet that can send (solana:signAndSendTransaction: VW's canSend) signs AND sends it itself, the way the Buy panel already
 *     does live (public/swap.js); its answer, its own signature, is the transaction's id, and that is watched. Our relay is not used.
 *     Why: a wallet like Phantom adds its own protection instructions to a transaction it is the first to sign (and may set the
 *     compute limit again), so a transaction it was only asked to sign came back with another message and this page refused it
 *     ("changed"), even with a priority fee. It leaves a transaction that other keys signed already as it is (a change would void
 *     their signatures, and the network would refuse it), and one it signs alone it may change, because it sends what it signed.
 *   - a wallet that only signs (solana:signTransaction) signs; this page checks that it changed nothing in the message (byte for
 *     byte) and that its signature is valid, puts every one-time signature at its slot again (a wallet may give back only its
 *     own), and sends through the site's relay (/api/swap/send, which only forwards what this Worker built: the ticket).
 * Either way /api/swap/status is then watched. A send whose outcome nobody knows (the relay's unclear: true, or no answer from the
 * site at all) is watched like any other: never "nothing was sent" until the chain says expired. Errors are thrown as
 * Error(message) with .code.
 * `wallet`: a wallet of public/wallets.js (VW.list(): .account.address, .canSend, .signAndSendTransaction(bytes, chain, options)
 * and .signTransaction(bytes, chain)), or any object with `address` and `signTransaction(bytes, chain)` (and, to send itself,
 * `signAndSendTransaction`; `canSend: false` keeps it on the relay).
 */
(function (root) {
  "use strict";
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function b58encode(bytes) {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    const digits = [];
    for (let i = zeros; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = "1".repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
    return out;
  }
  function b58decode(str) {
    const bytes = [];
    for (const ch of String(str)) {
      let carry = ALPHABET.indexOf(ch);
      if (carry < 0) throw new Error("bad base58");
      for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (const ch of String(str)) { if (ch !== "1") break; bytes.push(0); }
    return Uint8Array.from(bytes.reverse());
  }
  const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  function compactU16(bytes, at) {
    let value = 0, size = 0;
    for (;;) {
      if (at + size >= bytes.length || size >= 3) throw err("bad_tx");
      const b = bytes[at + size];
      value |= (b & 0x7f) << (7 * size); size++;
      if ((b & 0x80) === 0) return { value, size };
    }
  }
  /** The parts of a transaction this page needs: where the signatures start, how many, the message, its signers. */
  function parse(tx) {
    const n = compactU16(tx, 0);
    const sigAt = n.size, msgAt = sigAt + 64 * n.value;
    if (n.value < 1 || n.value > 8 || msgAt >= tx.length) throw err("bad_tx");
    const message = tx.subarray(msgAt);
    let at = (message[0] & 0x80) !== 0 ? 1 : 0;
    const required = message[at];
    at += 3;
    const nk = compactU16(message, at); at += nk.size;
    if (required !== n.value || nk.value < required || at + 32 * nk.value > message.length) throw err("bad_tx");
    const signers = [];
    for (let i = 0; i < required; i++) signers.push(b58encode(message.subarray(at + 32 * i, at + 32 * i + 32)));
    return { count: n.value, sigAt, msgAt, message, signers };
  }

  /* ---------------------------------------------------------------- plain words */
  const WORDS = {
    unsupported: "This browser cannot make the one-time keys this step needs. Open this page in an up-to-date Chrome or Safari, or in Phantom's own browser. Nothing was sent.",
    no_wallet: "Connect your wallet first.",
    no_sign: "This wallet cannot sign transactions here. Use Phantom, or another wallet that can sign a transaction without sending it.",
    wrong_wallet: "The wallet you connected is not the one this was built for (the wallet you are signed in with). Switch accounts in your wallet and start again.",
    cluster_mismatch: "This page and the site disagree about the network. Reload the page. Nothing was sent.",
    wrong_cluster: "The site's blockchain node is not on the network this page shows. Nothing was built; tell the team.",
    changed: "Your wallet changed the transaction before signing it, so nothing was sent. Start again; if it happens again, tell the team.",
    bad_signature: "Your wallet's signature does not check out, so nothing was sent. Start again.",
    rejected: "You cancelled in your wallet. Nothing was sent.",
    // the wallet that sends itself answered with an error, not a signature: it most likely sent nothing, but only the chain can say
    wallet_send_failed: "Your wallet answered with an error instead of sending this (for example, its own check of the transaction found a problem), so most likely nothing was sent. Reload the page to see where things stand, then start again; if it happens again, tell the team.",
    cancelled: "Stopped. Nothing was sent.",
    not_enabled: "This is not switched on yet.",
    sign_in: "Sign in again, then start again.",
    reprove: "For your safety, confirm it's you with your wallet again (needed every 30 minutes), then start again.",
    forbidden: "Only the site owner can do this.",
    slow_down: "Too many tries in a short time. Wait a minute and start again.",
    rpc_unavailable: "The blockchain could not be reached just now. Nothing was sent. Try again in a minute.",
    rpc_busy: "The blockchain node is busy. Nothing was sent. Try again in a minute.",
    insufficient_sol: "Your wallet does not have enough SOL for this step (the network fee and any rent). Nothing was sent.",
    insufficient_balance: "A token account holds less than this step needs. Nothing was sent.",
    blockhash_expired: "This took too long and the transaction ran out of time. Nothing was sent. Start again.",
    tx_too_large: "This transaction is too big for one Solana transaction. Nothing was sent; tell the team.",
    lookup_table_missing: "The site's speed table could not be read. Nothing was sent; tell the team.",
    unexpected_signer: "This step would need a key that is not yours. Nothing was built; tell the team.",
    bad_ticket: "Only a transaction built on this site can be sent from here. Start again.",
    unsigned: "A signature was missing, so nothing was sent. Start again.",
    bad_tx: "The transaction could not be read. Nothing was sent. Start again.",
    rejected_by_network: "The network refused the transaction. Nothing was spent except possibly the network fee. Start again.",
    program_error: "The program refused this step",
    failed: "The transaction failed on the blockchain.",
    expired: "The transaction was not included in time. Nothing was spent. Start again.",
    unconfirmed: "Sent, but not confirmed yet after 90 seconds. Check the explorer link before trying again.",
  };
  const say = (code, extra) => {
    if (code === "program_error" && extra && extra.name) return `${WORDS.program_error}${extra.programName ? ` (${extra.programName})` : ""}: ${extra.name}. Nothing was sent.`;
    return (extra && extra.message && !WORDS[code] ? extra.message : WORDS[code]) || "Something went wrong. Nothing was sent. Start again.";
  };
  function err(code, extra) { const e = new Error(say(code, extra)); e.code = code; if (extra) e.detail = extra; return e; }
  const isReject = (e) => e && (e.code === 4001 || /reject|denied|cancel|declin/i.test(String(e.message || e)));

  /* ---------------------------------------------------------------- one-time keys */
  let supportedMemo = null;
  /** Is WebCrypto Ed25519 there (a non-extractable key that signs, with a readable public half)? */
  function supported() {
    if (!supportedMemo) {
      supportedMemo = (async () => {
        try {
          const subtle = root.crypto && root.crypto.subtle;
          if (!subtle) return false;
          const kp = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
          const pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
          const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, kp.privateKey, new Uint8Array([1, 2, 3])));
          return pub.length === 32 && sig.length === 64 && kp.privateKey.extractable === false;
        } catch { return false; }
      })();
    }
    return supportedMemo;
  }
  /** n one-time keys: { publicKey, sign(bytes) }. The private half stays inside the browser's crypto, unreadable even to this page. */
  async function ephemeral(n) {
    const count = Number(n) || 0;
    if (count < 0 || count > 3) throw err("unexpected_signer");
    if (count && !(await supported())) throw err("unsupported");
    const out = [];
    for (let i = 0; i < count; i++) {
      const kp = await root.crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]);
      const publicKey = b58encode(new Uint8Array(await root.crypto.subtle.exportKey("raw", kp.publicKey)));
      out.push(Object.freeze({ publicKey, sign: async (bytes) => new Uint8Array(await root.crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes)) }));
    }
    return out;
  }
  async function verify(publicKey, message, signature) {
    try {
      const k = await root.crypto.subtle.importKey("raw", b58decode(publicKey), { name: "Ed25519" }, false, ["verify"]);
      return await root.crypto.subtle.verify({ name: "Ed25519" }, k, signature, message);
    } catch { return false; }
  }

  /* ---------------------------------------------------------------- the network */
  async function call(path, body) {
    let res, data = null;
    try {
      res = await root.fetch(path, body === undefined ? { headers: { accept: "application/json" }, credentials: "same-origin" }
        : { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
      data = await res.json();
    } catch { return { ok: false, error: "rpc_unavailable", _status: res ? res.status : 0, _noAnswer: true }; } // no JSON answer from the site
    if (data && typeof data === "object") data._status = res.status;
    return data || { ok: false, error: "rpc_unavailable" };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const addressOf = (w) => (w && (w.address || (w.account && w.account.address))) || null;
  const chainOf = (cluster) => `solana:${cluster === "devnet" ? "devnet" : "mainnet"}`;
  /** Does this wallet sign AND send (solana:signAndSendTransaction)? VW's canSend says so; `canSend: false` keeps it on the relay. */
  const sendsItself = (w) => w.canSend !== false && typeof w.signAndSendTransaction === "function";
  /** A sending wallet's answer (the 64-byte signature, or its base58 text) as the transaction's id, or null. */
  const idOf = (s) => {
    if (typeof s === "string") return /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s) ? s : null;
    try { const u = s instanceof Uint8Array ? s : new Uint8Array(s || []); return u.length === 64 ? b58encode(u) : null; } catch { return null; }
  };

  /** Build (the page's own `build(pubkeys)` calls its route) and check what came back; a handle whose sign() the person's tap calls. */
  async function prepare({ wallet, build, ephemeral: n = 0, cluster } = {}) {
    const who = addressOf(wallet);
    if (!who) throw err("no_wallet");
    if (typeof wallet.signTransaction !== "function" || wallet.canSign === false) throw err("no_sign");
    const keys = await ephemeral(n);
    const res = await build(keys.map((k) => k.publicKey));
    if (!res || res.ok !== true) throw err((res && res.error) || "rpc_unavailable", res || undefined);
    if (cluster && res.cluster !== cluster) throw err("cluster_mismatch");
    const tx = fromB64(res.tx);
    const p = parse(tx);
    if (p.signers[0] !== who) throw err("wrong_wallet");
    const want = new Set([who, ...keys.map((k) => k.publicKey)]);
    if (p.signers.length !== want.size || !p.signers.every((s) => want.has(s))) throw err("unexpected_signer");
    let used = false;
    return {
      response: res, keys: keys.map((k) => k.publicKey),
      /**
       * Call this straight from a tap. The one-time keys sign first (slot 0 stays empty), then a wallet that sends signs and sends
       * it itself, and a wallet that only signs signs, the checks run and the relay sends; then the watch.
       */
      async sign({ onStatus = () => {} } = {}) {
        if (used) throw err("cancelled");
        used = true;
        onStatus("signing");
        // the one-time keys sign the very message prepare() checked, each at its own slot of a copy of the built bytes (a few
        // milliseconds of the browser's own crypto, nothing over the network: the wallet still opens from the tap)
        const partial = tx.slice(), oneTime = [];
        for (const k of keys) {
          const i = p.signers.indexOf(k.publicKey);
          if (i < 1) throw err("unexpected_signer");
          let sig;
          try { sig = await k.sign(p.message); } catch { throw err("unsupported"); }
          partial.set(sig, p.sigAt + 64 * i);
          oneTime.push({ i, sig });
        }
        const chain = res.chain || chainOf(res.cluster);
        if (sendsItself(wallet)) {
          // the wallet signs and sends (as public/swap.js does): its signature is the transaction's id. A wallet like Phantom may add
          // its own checks to a transaction only it signs, and then sends what it signed; one the one-time keys signed it leaves as it is.
          let id;
          try { id = idOf(await wallet.signAndSendTransaction(partial.slice(), chain, { preflightCommitment: "confirmed", maxRetries: 3 })); }
          catch (e) { throw isReject(e) ? err("rejected") : err("wallet_send_failed", { message: e && e.message }); }
          if (!id) throw err("wallet_send_failed");
          onStatus("confirming", id);
          return watch(id, res, onStatus);
        }
        let signed;
        try { signed = await wallet.signTransaction(partial.slice(), chain); }
        catch (e) { throw isReject(e) ? err("rejected") : err(e && e.code === "no_sign" ? "no_sign" : "rejected", { message: e && e.message }); }
        signed = signed instanceof Uint8Array ? new Uint8Array(signed) : new Uint8Array(signed || []);
        let q;
        try { q = parse(signed); } catch { throw err("changed"); }
        if (q.count !== p.count || !same(q.message, p.message)) throw err("changed");
        if (!(await verify(who, p.message, signed.subarray(q.sigAt, q.sigAt + 64)))) throw err("bad_signature");
        // every one-time signature at its own slot again: a wallet may give back its own signature only
        for (const o of oneTime) signed.set(o.sig, q.sigAt + 64 * o.i);
        onStatus("sending");
        // the transaction's id: the wallet's own signature (slot 0, the fee payer), known before anything is sent
        const own = b58encode(signed.subarray(q.sigAt, q.sigAt + 64));
        const sent = await call("/api/swap/send", { tx: toB64(signed), ticket: res.ticket, lastValidBlockHeight: res.lastValidBlockHeight, cluster: res.cluster });
        // No answer from the site (the connection dropped, a gateway's error page): the relay may already have passed the bytes on,
        // so this never says "nothing was sent" (a second tap would do it twice). Like the relay's own unclear: true (src/relay.js),
        // the wallet's signature is watched: confirmed, failed, or expired once the chain passed its last valid block (nothing spent).
        if (sent && sent._noAnswer) { onStatus("confirming", own, { unclear: true }); return watch(own, res, onStatus); }
        if (!sent || sent.ok !== true || !sent.signature) throw err((sent && sent.error) || "rpc_unavailable", sent || undefined);
        onStatus("confirming", sent.signature, sent.unclear ? { unclear: true } : undefined);
        return watch(sent.signature, res, onStatus);
      },
    };
  }
  /** Poll /api/swap/status every 2 s for up to 90 s of real answers (a 429 waits and does not count). */
  async function watch(signature, res, onStatus) {
    let deadline = Date.now() + 90_000, solscan = null;
    for (;;) {
      await wait(LP._pollMs);
      const d = await call(`/api/swap/status?sig=${encodeURIComponent(signature)}&lvbh=${encodeURIComponent(res.lastValidBlockHeight || "")}&cluster=${encodeURIComponent(res.cluster || "mainnet")}`);
      if (d && d.solscan) solscan = d.solscan;
      if (d && d.ok && (d.status === "confirmed" || d.status === "finalized")) { onStatus("done", signature); return { signature, status: d.status, solscan }; }
      if (d && d.ok && d.status === "failed") throw Object.assign(err("failed"), { signature, solscan, detail: d });
      if (d && d.ok && d.status === "expired") throw Object.assign(err("expired"), { signature, solscan });
      if (d && d._status === 429) deadline += 5_000;
      if (Date.now() > deadline) throw Object.assign(err("unconfirmed"), { signature, solscan });
    }
  }
  /** prepare, show (onSummary resolves true to go on), sign. */
  async function run({ wallet, build, ephemeral: n = 0, cluster, onSummary, onStatus } = {}) {
    const h = await prepare({ wallet, build, ephemeral: n, cluster });
    if (onSummary && (await onSummary(h.response)) === false) throw err("cancelled");
    return h.sign({ onStatus });
  }

  /* ---------------------------------------------------------------- the summary a person reads before the wallet opens */
  const fmtSol = (lamports) => {
    const v = Number(lamports) / 1e9;
    const s = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 9 });
    return `${v < 0 ? "−" : v > 0 ? "+" : ""}${s} SOL`;
  };
  const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a || ""));
  /** Fill `el` with the plain-word summary of a build answer. Only createElement and textContent: nothing from the answer is ever HTML. */
  function renderSummary(el, res) {
    const doc = el.ownerDocument || root.document;
    const node = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
    el.textContent = "";
    if (!res || res.ok !== true) { el.append(node("p", "lp-sum__error", say(res && res.error, res || undefined))); return el; }
    if (res.cluster === "mainnet") el.append(node("p", "lp-sum__net lp-sum__net--main", "Solana MAINNET: real SOL"));
    else el.append(node("p", "lp-sum__net", `Solana ${res.cluster || "devnet"} (test network)`));
    const money = node("ul", "lp-sum__sol");
    for (const [addr, d] of Object.entries(res.solChange || {})) {
      const who = addr === (res.signers && res.signers[0]) ? "Your wallet" : short(addr);
      money.append(node("li", null, d == null ? `${who}: the network did not report the change` : `${who}: ${fmtSol(d)}${addr === (res.signers && res.signers[0]) ? " (network fee included)" : ""}`));
    }
    el.append(node("p", "lp-sum__h", "What changes in SOL"), money);
    const list = node("ol", "lp-sum__ixs");
    for (const ix of res.summary || []) {
      const li = node("li", null);
      li.append(node("strong", null, `${ix.programName || "Unknown program"}: ${ix.say || "unknown instruction"}`));
      if (ix.ix) li.append(node("span", "lp-sum__raw", ` (${ix.ix})`));
      if (ix.detail) li.append(node("span", "lp-sum__detail", ` · ${ix.detail}`));
      const accts = node("ul", "lp-sum__accts");
      for (const a of ix.accounts || []) accts.append(node("li", null, `${a.label ? `${a.label} ` : ""}${a.address}${a.role && a.role !== "read-only" ? ` (${a.role})` : ""}`));
      if ((ix.accounts || []).length) {
        const more = node("details", "fold lp-sum__more"); // the site's fold (design v2): the accounts one tap away, under the instruction
        more.append(node("summary", null, `${ix.accounts.length} account${ix.accounts.length === 1 ? "" : "s"}`), accts);
        li.append(more);
      }
      list.append(li);
    }
    el.append(node("p", "lp-sum__h", "What your wallet will be asked to sign"), list);
    const signers = (res.signers || []).length;
    el.append(node("p", "lp-sum__foot", `${signers > 1 ? `Signed by your wallet and ${signers - 1} one-time key${signers === 2 ? "" : "s"} made in this browser (never stored, never sent). ` : "Signed by your wallet only. "}Simulated on the blockchain just now: ${res.simulation && res.simulation.unitsConsumed ? `${Number(res.simulation.unitsConsumed).toLocaleString("en-US")} compute units` : "it would succeed"}.`));
    return el;
  }

  const LP = { supported, ephemeral, prepare, run, renderSummary, say, _pollMs: 2000, _b58: { encode: b58encode, decode: b58decode }, _parse: parse };
  root.LP = LP;
})(typeof window !== "undefined" ? window : globalThis);

/**
 * Sending e-mail. Used for one thing: the 6-digit sign-in code (auth.js, "sign in with your
 * e-mail"). This file only sends. It stores nothing: not the address, not the code. (auth.js keeps
 * a hash of the code in the database.) On failure it logs only a short reason: the first 60
 * characters of Gmail's reply, the HTTP status from Resend, or the text of a failed network call.
 *
 * Two ways to send. Which one is used depends on which secrets are set in Cloudflare
 * (Workers → vicinity-map → Settings → Variables and secrets):
 *   GMAIL_USER, GMAIL_APP_PASSWORD   send through Gmail's SMTP server (smtp.gmail.com, port 587)
 *                                    over a raw Workers socket. Spaces in the app password are ignored,
 *                                    so it can be pasted the way Google shows it.
 *   RESEND_API_KEY                   send through the Resend web API instead.
 *   EMAIL_FROM                       optional sender for Resend. Default: Vicinity <noreply@vicinity.city>
 * If both are set, Gmail is used (there is no fallback to Resend when Gmail fails). If neither is set,
 * e-mail sign-in is switched off: emailConfigured() is false and the API answers "email_unavailable".
 *
 * The senders answer { ok: true } or { ok: false, error: "email_unavailable" }. They catch their
 * own errors instead of throwing, so a broken mail provider can't take the sign-in route down with it.
 *
 * Both senders can be replaced for tests (see sendMail), so the test suite never opens a socket.
 */

/** Give up on the whole Gmail conversation (connect, TLS, login, send) after 12 seconds. */
const SMTP_TIMEOUT_MS = 12e3;

/**
 * Base64 for the SMTP login. btoa() only takes characters up to code 255, so anything beyond that
 * is swapped for "?" first (a password or address with such characters would not work).
 */
const b64 = (s) => btoa(String(s).replace(/[^\x00-\xff]/g, "?"));

/* ---------------- a tiny SMTP client ---------------- */

/**
 * Just enough SMTP to log in to Gmail and send one message. It wraps a Workers TCP socket: send a
 * command, read the server's reply, check the reply code. Any unexpected reply throws, and the
 * caller (sendViaGmail) turns that into "email_unavailable".
 *
 * (Comments sit here, not on the methods: the bundler keeps comments written inside a class body,
 * which would change the deployed bundle.)
 *
 * constructor(socket)  Take over a connected socket: one reader and one writer, and an empty
 *                      buffer for replies that are only half read.
 * readLine()           Read one reply line (up to CRLF, which is removed). Waits for more data if
 *                      the line isn't complete. Throws "smtp_eof" if the server hangs up.
 * expect(...codes)     Wait for a full reply and check its 3-digit code is one of `codes`. A reply
 *                      can span several lines ("250-..." continues, "250 ..." is the last), so
 *                      lines with a dash are skipped. Otherwise throws "smtp_" plus the first 60
 *                      characters of the server's line. Returns the last line.
 * cmd(text, codes)     Send one command line, then expect(). `codes` is one accepted reply code,
 *                      or a list of them.
 * startTls()           Switch the open connection to TLS (call it after the server said "220" to
 *                      STARTTLS), so the login and the message don't travel in the clear. The
 *                      reader and writer are let go first and fetched again from the upgraded
 *                      socket. Anything buffered from before the upgrade is thrown away.
 * data(message)        Send the message after the DATA command and wait for the "250" that says it
 *                      was accepted. Dot-stuffing: a line that starts with "." gets a second "."
 *                      so it can't be mistaken for the lone "." that ends the message. (Only lines
 *                      split by CRLF are looked at.)
 * close()              Let go of the reader, writer and socket. Each step is wrapped, so a
 *                      half-closed connection never throws from here.
 */
class Smtp {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buf = "";
  }

  async readLine() {
    for (; ; ) {
      const i = this.buf.indexOf("\r\n");
      if (i >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("smtp_eof");
      this.buf += new TextDecoder().decode(value);
    }
  }

  async expect(...codes) {
    let line;
    do {
      line = await this.readLine();
    } while (/^\d{3}-/.test(line));
    if (!codes.includes(Number(line.slice(0, 3)))) throw new Error("smtp_" + line.slice(0, 60));
    return line;
  }

  async cmd(text, codes) {
    await this.writer.write(new TextEncoder().encode(text + "\r\n"));
    return this.expect(...[].concat(codes));
  }

  async startTls() {
    this.reader.releaseLock();
    this.writer.releaseLock();
    await this.socket.startTls();
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buf = "";
  }

  async data(message) {
    const stuffed = message.split("\r\n").map((l) => l.startsWith(".") ? "." + l : l).join("\r\n");
    await this.writer.write(new TextEncoder().encode(stuffed + "\r\n.\r\n"));
    await this.expect(250);
  }

  close() {
    try {
      this.reader.releaseLock();
    } catch {
    }
    try {
      this.writer.releaseLock();
    } catch {
    }
    try {
      this.socket.close();
    } catch {
    }
  }
}

/* ---------------- building the message ---------------- */

/**
 * The raw text of an e-mail with a plain-text part and an HTML part (the reader's mail app shows
 * the better one). The From, To and Subject values are squashed onto one line and cut at 200
 * characters, so a stray line break in an address or subject can't add extra headers.
 * The boundary between the two parts is the fixed word "vicinity-boundary".
 *
 * Looks like a bug: the headers run straight into the first "--vicinity-boundary" line, with no
 * empty line between them (the mail standard asks for one). Mail servers that are strict about
 * this may not read the message as intended. The bundle is kept exactly as deployed, so this is
 * left as it is. Also, the bodies that verificationEmail() builds use bare "\n" line breaks, not CRLF.
 */
function mimeMessage({ from, to, subject, text, html }) {
  const safe = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 200);
  const head = [
    "From: " + safe(from),
    "To: " + safe(to),
    "Subject: " + safe(subject),
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="vicinity-boundary"',
    "Content-Transfer-Encoding: 8bit",
    ""
  ].join("\r\n");
  const part = (ct, body) => ["--vicinity-boundary", `Content-Type: ${ct}; charset=utf-8`, "", body].join("\r\n");
  return head + part("text/plain", text) + "\r\n" + part("text/html", html) + "\r\n--vicinity-boundary--\r\n";
}

/**
 * The raw text of a plain-text-only e-mail (headers, an empty line, the text). Used when no HTML
 * was given. Same one-line, 200-character clean-up of the header values as mimeMessage.
 */
function rawMessage({ from, to, subject, text }) {
  const safe = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 200);
  return [
    "From: " + safe(from),
    "To: " + safe(to),
    "Subject: " + safe(subject),
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text
  ].join("\r\n");
}

/* ---------------- the two ways to send ---------------- */

/**
 * Send through Gmail: connect to smtp.gmail.com:587, upgrade to TLS with STARTTLS, log in with
 * AUTH LOGIN (user + app password), send the message from the Gmail account itself as
 * "Vicinity <user>", and QUIT. The whole thing must finish within SMTP_TIMEOUT_MS.
 * Returns { ok: true } only after the server has also answered QUIT.
 *
 * `smtpImpl` is a test hook: if given, it is called with { user, pass, from, to, subject, text, html }
 * instead of opening a socket, and its answer is returned as is. The socket module is loaded only
 * when needed, since it exists only inside Cloudflare's runtime.
 * The address `to` goes into the SMTP command as given. auth.js checks it (no spaces) before calling.
 *
 * Looks like a bug: connect() is called without { secureTransport: "starttls" }, and Cloudflare's
 * runtime refuses startTls() on a socket opened without it. If so, every Gmail send fails at the
 * STARTTLS step and answers "email_unavailable". Unverified here: it needs a real Worker to confirm.
 */
async function sendViaGmail(env, { to, subject, text, html }, smtpImpl) {
  const user = env.GMAIL_USER;
  const pass = String(env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) return { ok: false, error: "email_unavailable" };
  if (smtpImpl) return smtpImpl({ user, pass, from: user, to, subject, text, html });
  let conn = null;
  const fail = (e) => {
    console.error("gmail smtp failed", String(e && e.message || e));
    return { ok: false, error: "email_unavailable" };
  };
  try {
    const { connect } = await import("cloudflare:sockets");
    const done = (async () => {
      conn = new Smtp(connect({ hostname: "smtp.gmail.com", port: 587 }));
      await conn.expect(220);
      await conn.cmd("EHLO vicinity.city", 250);
      await conn.cmd("STARTTLS", 220);
      await conn.startTls();
      await conn.cmd("EHLO vicinity.city", 250);
      await conn.cmd("AUTH LOGIN", 334);
      await conn.cmd(b64(user), 334);
      await conn.cmd(b64(pass), 235);
      await conn.cmd(`MAIL FROM:<${user}>`, 250);
      await conn.cmd(`RCPT TO:<${to}>`, [250, 251]);
      await conn.cmd("DATA", 354);
      await conn.data(html ? mimeMessage({ from: `Vicinity <${user}>`, to, subject, text, html }) : rawMessage({ from: `Vicinity <${user}>`, to, subject, text }));
      await conn.cmd("QUIT", 221);
      return { ok: true };
    })();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("smtp_timeout")), SMTP_TIMEOUT_MS));
    return await Promise.race([done, timeout]);
  } catch (e) {
    return fail(e);
  } finally {
    if (conn) conn.close();
  }
}

/**
 * Send through the Resend web API: one POST to https://api.resend.com/emails with the API key as a
 * bearer token. The sender is EMAIL_FROM, or "Vicinity <noreply@vicinity.city>" if that isn't set.
 * The HTML part is added only if there is one. A network error or a non-2xx answer logs a short
 * reason (never the address or the code) and gives "email_unavailable".
 * `fetchImpl` is passed in so tests can fake the network.
 */
async function sendViaResend(env, { to, subject, text, html }, fetchImpl) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "email_unavailable" };
  const from = env.EMAIL_FROM || "Vicinity <noreply@vicinity.city>";
  const body = { from, to: [to], subject, text };
  if (html) body.html = html;
  let res;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error("code e-mail failed", String(e));
    return { ok: false, error: "email_unavailable" };
  }
  if (!res.ok) {
    console.error("code e-mail failed", res.status);
    return { ok: false, error: "email_unavailable" };
  }
  return { ok: true };
}

/**
 * Send one e-mail: { to, subject, text, html? }. Gmail if GMAIL_USER and GMAIL_APP_PASSWORD are both
 * set, otherwise Resend (which says "email_unavailable" if its key is missing too).
 * `deps` is for tests: { fetchImpl } replaces fetch for Resend, { smtpImpl } replaces the Gmail socket.
 */
export async function sendMail(env, { to, subject, text, html }, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) return sendViaGmail(env, { to, subject, text, html }, deps.smtpImpl || null);
  return sendViaResend(env, { to, subject, text, html }, fetchImpl);
}

/** Is any e-mail sending set up (Gmail login or Resend key)? When false, e-mail sign-in is off. */
export const emailConfigured = (env) => Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD || env.RESEND_API_KEY);

/* ---------------- the sign-in code e-mail ---------------- */

/**
 * The e-mail that carries a sign-in code: the subject ("123456 is your Vicinity code"), a plain-text
 * body, and a dark-themed HTML body (table layout and inline styles, as mail apps need). Both say
 * the code expires in 10 minutes (that matches CODE_SECONDS in auth.js) and link to
 * https://vicinity.city/connect. The code is escaped before going into the HTML.
 */
export function verificationEmail(code) {
  const subject = `${code} is your Vicinity code`;
  const text = `Your Vicinity sign-in code is ${code}.

Enter it at https://vicinity.city/connect — it expires in 10 minutes.
If you didn't ask for this, just ignore this email.

— Vicinity · One city. One coin. One community.`;
  const esc = String(code).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#060C17;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your Vicinity sign-in code is ${esc}. It expires in 10 minutes.</div>
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#060C17;padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;background-color:#0A1322;border:1px solid #1B2A44;border-radius:16px;">
<tr><td align="center" style="padding:36px 32px 8px;">
<div style="font-family:'Space Grotesk',Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;letter-spacing:6px;color:#FFFFFF;">VICINITY<span style="color:#FF5A36;">.</span></div>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:3px;color:#8A97AD;margin-top:10px;">ONE CITY &middot; ONE COIN &middot; ONE COMMUNITY</div>
</td></tr>
<tr><td align="center" style="padding:28px 32px 4px;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#E8EDF5;">Your sign-in code</div>
</td></tr>
<tr><td align="center" style="padding:12px 32px;">
<table cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="background-color:#0F1C31;border:1px solid #FFC857;border-radius:12px;padding:18px 36px;">
<div style="display:inline-block;font-family:'Courier New',Courier,monospace;font-size:44px;font-weight:700;letter-spacing:10px;padding-left:10px;color:#FFC857;">${esc}</div>
</td></tr></table>
</td></tr>
<tr><td align="center" style="padding:14px 48px 4px;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:#8A97AD;">Enter this code on vicinity.city to finish signing in.<br>It expires in <b style="color:#E8EDF5;">10 minutes</b>.</div>
</td></tr>
<tr><td align="center" style="padding:18px 32px 36px;">
<a href="https://vicinity.city/connect" style="display:inline-block;background-color:#FF5A36;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:13px 40px;border-radius:999px;">Enter code</a>
</td></tr>
<tr><td align="center" style="padding:0 48px 32px;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.8;color:#5A6B87;">If you didn't request this code, you can safely ignore this email.<br>&copy; 2026 Vicinity &middot; <a href="https://vicinity.city" style="color:#5B8CFF;text-decoration:none;">vicinity.city</a></div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}

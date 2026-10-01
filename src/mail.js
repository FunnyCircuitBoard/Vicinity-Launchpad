/**
 * Outgoing e-mail for sign-in codes. Two ways to send, first one configured wins:
 *   1. Gmail: GMAIL_USER + GMAIL_APP_PASSWORD (a Google "app password", 2 minutes to make).
 *      The worker talks SMTP (port 587 + STARTTLS) straight to smtp.gmail.com — no new
 *      service, no domain verification.
 *   2. Resend: RESEND_API_KEY (REST API), EMAIL_FROM sets the sender.
 *
 * `deps.smtpImpl` lets tests fake the whole SMTP conversation; `deps.fetchImpl` fakes Resend.
 */
const SMTP_TIMEOUT_MS = 12_000;

const b64 = (s) => btoa(String(s).replace(/[^\x00-\xff]/g, "?"));

class Smtp {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buf = "";
  }
  async readLine() {
    for (;;) {
      const i = this.buf.indexOf("\r\n");
      if (i >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); return line; }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("smtp_eof");
      this.buf += new TextDecoder().decode(value);
    }
  }
  async expect(...codes) {
    let line;
    do { line = await this.readLine(); } while (/^\d{3}-/.test(line)); // multi-line replies
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
    const stuffed = message.split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
    await this.writer.write(new TextEncoder().encode(stuffed + "\r\n.\r\n"));
    await this.expect(250);
  }
  close() {
    try { this.reader.releaseLock(); } catch {}
    try { this.writer.releaseLock(); } catch {}
    try { this.socket.close(); } catch {}
  }
}

function rawMessage({ from, to, subject, text }) {
  const safe = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 200);
  return ["From: " + safe(from), "To: " + safe(to), "Subject: " + safe(subject),
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", text].join("\r\n");
}

async function sendViaGmail(env, { to, subject, text }, smtpImpl) {
  const user = env.GMAIL_USER;
  const pass = String(env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) return { ok: false, error: "email_unavailable" };
  if (smtpImpl) return smtpImpl({ user, pass, from: user, to, subject, text });

  let conn = null;
  const fail = (e) => { console.error("gmail smtp failed", String(e && e.message || e)); return { ok: false, error: "email_unavailable" }; };
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
      await conn.data(rawMessage({ from: `Vicinity <${user}>`, to, subject, text }));
      await conn.cmd("QUIT", 221);
      return { ok: true };
    })();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("smtp_timeout")), SMTP_TIMEOUT_MS));
    return await Promise.race([done, timeout]);
  } catch (e) { return fail(e); }
  finally { if (conn) conn.close(); }
}

async function sendViaResend(env, { to, subject, text }, fetchImpl) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "email_unavailable" };
  const from = env.EMAIL_FROM || "Vicinity <noreply@vicinity.city>";
  let res;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
  } catch (e) { console.error("code e-mail failed", String(e)); return { ok: false, error: "email_unavailable" }; }
  if (!res.ok) { console.error("code e-mail failed", res.status); return { ok: false, error: "email_unavailable" }; }
  return { ok: true };
}

export async function sendMail(env, { to, subject, text }, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) return sendViaGmail(env, { to, subject, text }, deps.smtpImpl || null);
  return sendViaResend(env, { to, subject, text }, fetchImpl);
}

/** E-mail sign-in is on when either sender is configured. */
export const emailConfigured = (env) => Boolean((env.GMAIL_USER && env.GMAIL_APP_PASSWORD) || env.RESEND_API_KEY);

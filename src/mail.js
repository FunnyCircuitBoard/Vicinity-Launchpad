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

function mimeMessage({ from, to, subject, text, html }) {
  const safe = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 200);
  const head = ["From: " + safe(from), "To: " + safe(to), "Subject: " + safe(subject),
    "MIME-Version: 1.0", "Content-Type: multipart/alternative; boundary=\"vicinity-boundary\"",
    "Content-Transfer-Encoding: 8bit", ""].join("\r\n");
  const part = (ct, body) => ["--vicinity-boundary", `Content-Type: ${ct}; charset=utf-8`, "", body].join("\r\n");
  return head + part("text/plain", text) + "\r\n" + part("text/html", html) + "\r\n--vicinity-boundary--\r\n";
}

function rawMessage({ from, to, subject, text }) {
  const safe = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 200);
  return ["From: " + safe(from), "To: " + safe(to), "Subject: " + safe(subject),
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", text].join("\r\n");
}

async function sendViaGmail(env, { to, subject, text, html }, smtpImpl) {
  const user = env.GMAIL_USER;
  const pass = String(env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) return { ok: false, error: "email_unavailable" };
  if (smtpImpl) return smtpImpl({ user, pass, from: user, to, subject, text, html });

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
      await conn.data(html ? mimeMessage({ from: `Vicinity <${user}>`, to, subject, text, html })
                           : rawMessage({ from: `Vicinity <${user}>`, to, subject, text }));
      await conn.cmd("QUIT", 221);
      return { ok: true };
    })();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("smtp_timeout")), SMTP_TIMEOUT_MS));
    return await Promise.race([done, timeout]);
  } catch (e) { return fail(e); }
  finally { if (conn) conn.close(); }
}

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
      body: JSON.stringify(body),
    });
  } catch (e) { console.error("code e-mail failed", String(e)); return { ok: false, error: "email_unavailable" }; }
  if (!res.ok) { console.error("code e-mail failed", res.status); return { ok: false, error: "email_unavailable" }; }
  return { ok: true };
}

export async function sendMail(env, { to, subject, text, html }, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) return sendViaGmail(env, { to, subject, text, html }, deps.smtpImpl || null);
  return sendViaResend(env, { to, subject, text, html }, fetchImpl);
}

/** E-mail sign-in is on when either sender is configured. */
export const emailConfigured = (env) => Boolean((env.GMAIL_USER && env.GMAIL_APP_PASSWORD) || env.RESEND_API_KEY);

/** The verification-code e-mail, branded like the site. Returns { subject, text, html }. */
export function verificationEmail(code) {
  const subject = `${code} is your Vicinity code`;
  const text = `Your Vicinity sign-in code is ${code}.\n\nEnter it at https://vicinity.city/connect — it expires in 10 minutes.\nIf you didn't ask for this, just ignore this email.\n\n— Vicinity · One city. One coin. One community.`;
  const esc = String(code).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
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

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Email sender backed by Resend. Without RESEND_API_KEY it runs in dry-run mode:
 * messages stay in the outbox and are marked sent locally, so development and tests work offline.
 */
export function createMailer({ apiKey = null, from = 'HealthMart <no-reply@example.com>', fetchImpl = globalThis.fetch } = {}) {
  return {
    dryRun: !apiKey,
    from,
    async send({ to, subject, text, html }) {
      if (!apiKey) return { id: null, dryRun: true };
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend responded ${res.status}`);
      return res.json();
    },
  };
}

const MAX_ATTEMPTS = 5;

/** Sends queued email rows. Retries on failure, marks failed after MAX_ATTEMPTS. */
export async function processOutbox(db, mailer, { batch = 25 } = {}) {
  const rows = db
    .prepare("SELECT id, recipient, subject, body, attempts FROM outbox WHERE channel = 'email' AND status = 'queued' ORDER BY id LIMIT ?")
    .all(batch);
  let sent = 0;
  for (const row of rows) {
    try {
      await mailer.send({ to: row.recipient, subject: row.subject, text: row.body });
      db.prepare("UPDATE outbox SET status = 'sent', attempts = attempts + 1, last_error = NULL WHERE id = ?").run(row.id);
      sent += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      db.prepare("UPDATE outbox SET status = ?, attempts = ?, last_error = ? WHERE id = ?").run(
        attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
        attempts,
        err.message,
        row.id,
      );
    }
  }
  return { attempted: rows.length, sent };
}

// ---- Templates (plain text is always included for deliverability) -------

export const templates = {
  verifyEmail: ({ name, link }) => ({
    subject: 'HealthMart: अपना email verify करें',
    text: `नमस्ते ${name},\n\nअपना email verify करने के लिए इस link पर जाएँ (48 घंटे तक valid):\n${link}\n\nअगर आपने account नहीं बनाया, तो इस email को अनदेखा करें।`,
  }),
  resetPassword: ({ name, link }) => ({
    subject: 'HealthMart: password reset',
    text: `नमस्ते ${name},\n\nनया password सेट करने के लिए इस link पर जाएँ (1 घंटे तक valid):\n${link}\n\nअगर आपने request नहीं की, तो इस email को अनदेखा करें।`,
  }),
  teamInvite: ({ companyName, inviterName, link, expiresOn }) => ({
    subject: `${companyName} ने आपको HealthMart टीम में बुलाया है`,
    text: `नमस्ते,\n\n${inviterName} ने आपको ${companyName} की टीम में HealthMart पर जोड़ा है।\nज्वाइन करने के लिए इस link पर जाएँ (${expiresOn} तक valid):\n${link}`,
  }),
  broadcast: ({ companyName, subject, message }) => ({
    subject: `${companyName}: ${subject}`,
    text: `${message}\n\n— ${companyName}, HealthMart पर`,
  }),
};

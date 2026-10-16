import { WorkerMailer } from "worker-mailer"
import type { Address } from "./Sender.ts"
import type { SmtpTransport } from "./smtp.ts"

/**
 * SMTP from a Worker over `cloudflare:sockets`, with implicit TLS on 465 and STARTTLS otherwise.
 * Import it only from Worker code: `cloudflare:sockets` doesn't exist in Node or Bun.
 *
 * A Worker can't open a TCP connection to an address on Cloudflare's own network, so the SMTP host must
 * be outside it (MBPrep measured Spacemail, mail.spacemail.com, as outside on 2026-10-02).
 */
const user = (a: Address) => (a.name ? { name: a.name, email: a.email } : { email: a.email })

const base64 = (bytes: Uint8Array) => {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export const workerSmtpTransport: SmtpTransport = {
  async send(config, m) {
    const mailer = await WorkerMailer.connect({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      startTls: config.port !== 465,
      credentials: { username: config.username, password: config.password },
      authType: ["plain", "login"],
    })
    try {
      await mailer.send({
        from: user(m.from),
        to: m.to.map(user),
        ...(m.cc ? { cc: m.cc.map(user) } : {}),
        ...(m.bcc ? { bcc: m.bcc.map(user) } : {}),
        ...(m.replyTo ? { reply: user(m.replyTo) } : {}),
        subject: m.subject,
        ...(m.text !== undefined ? { text: m.text } : {}),
        ...(m.html !== undefined ? { html: m.html } : {}),
        ...(m.headers ? { headers: { ...m.headers } } : {}),
        ...(m.attachments
          ? {
              attachments: m.attachments.map((a) => ({
                filename: a.filename,
                content: base64(a.content),
                mimeType: a.type,
              })),
            }
          : {}),
      })
    } finally {
      await mailer.close().catch(() => undefined)
    }
  },
}

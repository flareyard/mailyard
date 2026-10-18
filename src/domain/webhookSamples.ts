import type { WebhookEvent } from "./webhooks.ts"

/**
 * A realistic sample of each event's `data` (HAL-3464), for `POST /v1/webhooks/{id}/test { event }`:
 * the same fields, in the same shapes, as the code that emits the real event, with made-up values
 * and `sample: true` so a receiver can tell. test/webhookSamples.test.ts holds each sample against
 * a real event of its type, so the two can't drift apart.
 */
const at = () => new Date().toISOString()

export const sampleEventData = (type: WebhookEvent): Record<string, unknown> => {
  const base = (data: Record<string, unknown>) => ({ ...data, sample: true })
  switch (type) {
    case "message.sent":
      return base({
        messageId: "msg_sample",
        cfMessageId: "<sample@mail.example.com>",
        recipient: "ada@example.com",
        subject: "Your receipt",
        stream: "transactional",
        campaignId: null,
        mailboxId: null,
      })
    case "message.delivered":
    case "message.deferred":
    case "message.bounced":
    case "message.failed":
    case "message.rejected":
    case "message.complained": {
      const kind = type.slice("message.".length)
      if (kind === "deferred" || kind === "failed" || kind === "rejected")
        return base({
          messageId: "msg_sample",
          recipient: "ada@example.com",
          reason: kind === "deferred" ? "421 Try again later" : "550 Mailbox unavailable",
          attempts: kind === "deferred" ? 1 : 8,
          ...(kind === "deferred" ? { retryInSeconds: 60 } : {}),
          stream: "transactional",
          campaignId: null,
          mailboxId: null,
        })
      return base({
        messageId: "msg_sample",
        cfMessageId: "<sample@mail.example.com>",
        recipient: "ada@example.com",
        subject: "Your receipt",
        provider: "gmail",
        smtpResponse: kind === "bounced" ? "550 5.1.1 The email account does not exist" : "250 2.0.0 OK",
        ...(kind === "bounced" ? { bounce: "hard" } : {}),
        at: at(),
        stream: "campaign",
        campaignId: "cmp_sample",
        mailboxId: null,
      })
    }
    case "email.opened":
    case "email.clicked":
      return base({
        messageId: "msg_sample",
        contactId: "con_sample",
        campaignId: "cmp_sample",
        ...(type === "email.clicked" ? { url: "https://example.com/pricing" } : {}),
      })
    case "contact.created":
      return base({ contactId: "con_sample", email: "ada@example.com", status: "subscribed" })
    case "contact.updated":
      return base({ contactId: "con_sample", email: "ada@example.com", status: "subscribed" })
    case "contact.subscribed":
    case "contact.unsubscribed":
      return base({
        contactId: "con_sample",
        email: "ada@example.com",
        topicId: "top_sample",
        source: "form",
      })
    case "contact.deleted":
      return base({ contactId: "con_sample", erased: true })
    case "contact.suppressed":
      return base({ email: "ada@example.com", reason: "hard_bounce" })
    case "contact.unsuppressed":
      return base({ email: "ada@example.com", reason: "hard_bounce", contactStatus: "subscribed" })
    case "event.tracked":
      return base({
        contactId: "con_sample",
        email: "ada@example.com",
        event: "signed_up",
        data: { plan: "team" },
      })
    case "campaign.paused":
      return base({ campaignId: "cmp_sample", reason: "bounce_rate" })
    case "campaign.sent":
      return base({ campaignId: "cmp_sample", messages: 1200 })
    case "mail.received":
      return base({
        id: "inb_sample",
        mailboxId: "mbx_sample",
        to: "support@example.com",
        via: "direct",
        tag: null,
        from: { name: "Ada Lovelace", address: "ada@example.org" },
        subject: "Question about my order",
        messageId: "<sample@example.org>",
        size: 4312,
        attachments: 1,
        auth: { spf: "pass", dkim: ["pass"], dmarc: "pass" },
        folder: "inbox",
        spam: { score: 0.4, isSpam: false },
        rulesMatched: [],
        receivedAt: at(),
      })
    case "mail.rule_matched":
      return base({
        id: "inb_sample",
        mailboxId: "mbx_sample",
        ruleId: "rul_sample",
        threadId: "thr_sample",
        from: { name: "Ada Lovelace", address: "ada@example.org" },
        subject: "Question about my order",
        messageId: "<sample@example.org>",
      })
    case "approval.pending":
      return base({
        approvalId: "apv_sample",
        keyId: "key_sample",
        kind: "draft",
        recipients: ["ada@example.org"],
        subject: "Re: Question about my order",
        mailboxId: "mbx_sample",
      })
    case "approval.approved":
      return base({ approvalId: "apv_sample", keyId: "key_sample", kind: "draft", decidedBy: "mem_sample" })
    case "approval.rejected":
      return base({
        approvalId: "apv_sample",
        keyId: "key_sample",
        kind: "draft",
        decidedBy: "mem_sample",
        reason: "Not now",
      })
    case "alert.raised":
      return base({
        alertId: "alr_sample",
        key: "quota_80",
        kind: "quota_80",
        severity: "warning",
        title: "80% of this month's sending used",
        detail: "Sample: at this rate the quota runs out before the month ends.",
        subject: null,
        escalated: false,
      })
  }
}

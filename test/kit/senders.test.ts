import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import {
  classifyCloudflareError,
  classifySmtpError,
  failover,
  Ids,
  MAX_ATTACHMENTS,
  makeCloudflareSender,
  makeSmtpSender,
  type Outgoing,
  type SendEmailBinding,
  type SendError,
  Sender,
  SenderCloudflareWithSmtpFallback,
  type SmtpTransport,
  validate,
} from "../../src/kit/index.ts"

const message: Outgoing = {
  from: { email: "hello@mbprep.app", name: "MBPrep" },
  to: [{ email: "ada@example.net", name: "Ada" }],
  cc: [{ email: "kemi@example.net" }],
  subject: "Your code",
  text: "123456",
  html: "<p>123456</p>",
  headers: { "List-Unsubscribe": "<https://mbprep.app/u/x>" },
}

const coded = (code: string, text = "refused") => Object.assign(new Error(text), { code })

const failure = async <A>(effect: Effect.Effect<A, SendError>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (error?._tag !== "Fail") throw new Error(`expected a typed failure, got ${String(exit.cause)}`)
  return error.error
}

describe("classifyCloudflareError: every code in the Workers API table", () => {
  it.each([
    ["E_VALIDATION_ERROR", "InvalidMessage"],
    ["E_FIELD_MISSING", "InvalidMessage"],
    ["E_TOO_MANY_RECIPIENTS", "InvalidMessage"],
    ["E_TOO_MANY_ATTACHMENTS", "InvalidMessage"],
    ["E_CONTENT_TOO_LARGE", "InvalidMessage"],
    ["E_HEADER_NOT_ALLOWED", "InvalidMessage"],
    ["E_HEADER_USE_API_FIELD", "InvalidMessage"],
    ["E_HEADER_VALUE_INVALID", "InvalidMessage"],
    ["E_HEADER_VALUE_TOO_LONG", "InvalidMessage"],
    ["E_HEADER_NAME_INVALID", "InvalidMessage"],
    ["E_HEADERS_TOO_LARGE", "InvalidMessage"],
    ["E_HEADERS_TOO_MANY", "InvalidMessage"],
    ["E_RATE_LIMIT_EXCEEDED", "SendDeferred"],
    ["E_INTERNAL_SERVER_ERROR", "SendDeferred"],
    ["E_DAILY_LIMIT_EXCEEDED", "QuotaExceeded"],
    ["E_RECIPIENT_SUPPRESSED", "SendSuppressed"],
    ["E_SENDER_NOT_VERIFIED", "SendRejected"],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", "SendRejected"],
    ["E_RECIPIENT_NOT_ALLOWED", "SendRejected"],
    ["E_DELIVERY_FAILED", "SendRejected"],
    ["E_SOMETHING_NEW", "SendRejected"],
  ])("%s → %s", (code, tag) => {
    expect(classifyCloudflareError(coded(code), message)._tag).toBe(tag)
  })

  it("treats an error with no code as transient", () => {
    expect(classifyCloudflareError(new Error("network connection lost"), message)._tag).toBe("SendDeferred")
  })

  it("names every recipient when they are suppressed", () => {
    const error = classifyCloudflareError(coded("E_RECIPIENT_SUPPRESSED"), message)
    expect(error._tag === "SendSuppressed" && error.recipients).toEqual([
      "ada@example.net",
      "kemi@example.net",
    ])
  })
})

describe("makeCloudflareSender", () => {
  it("passes the message to the binding in its shape and returns the message id", async () => {
    const calls: Array<Parameters<SendEmailBinding["send"]>[0]> = []
    const binding: SendEmailBinding = {
      send: async (m) => {
        calls.push(m)
        return { messageId: "cf-123" }
      },
    }
    const result = await Effect.runPromise(makeCloudflareSender(binding).send(message))
    expect(result).toEqual({ messageId: "cf-123" })
    expect(calls).toEqual([
      {
        from: { email: "hello@mbprep.app", name: "MBPrep" },
        to: [{ email: "ada@example.net", name: "Ada" }],
        cc: ["kemi@example.net"],
        subject: "Your code",
        text: "123456",
        html: "<p>123456</p>",
        headers: { "List-Unsubscribe": "<https://mbprep.app/u/x>" },
      },
    ])
  })

  it("maps a thrown code to a typed error", async () => {
    const binding: SendEmailBinding = {
      send: () => Promise.reject(coded("E_DAILY_LIMIT_EXCEEDED", "Daily limit reached")),
    }
    expect((await failure(makeCloudflareSender(binding).send(message)))._tag).toBe("QuotaExceeded")
  })

  it("never calls the binding for a message that breaks a limit", async () => {
    let called = false
    const binding: SendEmailBinding = {
      send: async () => {
        called = true
        return { messageId: "x" }
      },
    }
    const error = await failure(
      makeCloudflareSender(binding).send({
        ...message,
        headers: { "X-Evil": "a\r\nBcc: victim@example.net" },
      }),
    )
    expect(error._tag).toBe("InvalidMessage")
    expect(called).toBe(false)
  })
})

describe("classifySmtpError", () => {
  it.each([
    ["421 4.7.0 Try again later, closing connection", "SendDeferred"],
    ["451 4.3.0 Temporary local problem", "SendDeferred"],
    ["550 5.1.1 The email account that you tried to reach does not exist", "SendRejected"],
    ["554 5.7.1 Sender hourly rate limit exceeded", "QuotaExceeded"],
    ["554 5.7.1 Message rejected as spam", "SendRejected"],
    ["Connection refused", "SendDeferred"],
    ["Socket timeout after 60000ms", "SendDeferred"],
  ])("%s → %s", (text, tag) => {
    expect(classifySmtpError(new Error(text))._tag).toBe(tag)
  })
})

describe("makeSmtpSender", () => {
  it("sets a Message-ID on the sender's domain and returns it", async () => {
    const sent: Array<Outgoing> = []
    const transport: SmtpTransport = { send: async (_config, m) => void sent.push(m) }
    const ids = Effect.runSync(
      Effect.gen(function* () {
        return yield* Ids
      }).pipe(Effect.provide(Ids.layerSequential("smtp"))),
    )
    const result = await Effect.runPromise(
      makeSmtpSender(
        { host: "mail.example.com", port: 465, username: "u", password: "p" },
        transport,
        ids,
      ).send(message),
    )
    expect(result.messageId).toBe("smtp_1@mbprep.app")
    expect(sent[0]?.headers?.["Message-ID"]).toBe("<smtp_1@mbprep.app>")
    expect(sent[0]?.headers?.["List-Unsubscribe"]).toBe("<https://mbprep.app/u/x>")
  })
})

describe("failover", () => {
  const sender = (result: SendError | string) => ({
    calls: 0,
    send(_m: Outgoing) {
      this.calls++
      return typeof result === "string" ? Effect.succeed({ messageId: result }) : Effect.fail(result)
    },
  })
  const run = (primary: SendError | string) => {
    const a = sender(primary)
    const b = sender("smtp-1")
    return Effect.runPromiseExit(failover(a, b).send(message)).then((exit) => ({ exit, a, b }))
  }

  it.each([
    ["E_RATE_LIMIT_EXCEEDED", true],
    ["E_INTERNAL_SERVER_ERROR", true],
    ["E_DAILY_LIMIT_EXCEEDED", true],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", true],
    ["E_SENDER_NOT_VERIFIED", true],
    ["E_RECIPIENT_SUPPRESSED", false],
    ["E_CONTENT_TOO_LARGE", false],
    ["E_DELIVERY_FAILED", false],
  ])("primary fails with %s → secondary used: %s", async (code, usesSecondary) => {
    const { exit, b } = await run(classifyCloudflareError(coded(code), message))
    expect(b.calls).toBe(usesSecondary ? 1 : 0)
    expect(Exit.isSuccess(exit)).toBe(usesSecondary)
  })

  it("doesn't touch the secondary when the primary succeeds", async () => {
    const { exit, a, b } = await run("cf-1")
    expect(Exit.isSuccess(exit) && exit.value.messageId).toBe("cf-1")
    expect([a.calls, b.calls]).toEqual([1, 0])
  })
})

describe("SenderCloudflareWithSmtpFallback", () => {
  it("falls back to SMTP when Email Service is over quota", async () => {
    const binding: SendEmailBinding = { send: () => Promise.reject(coded("E_DAILY_LIMIT_EXCEEDED")) }
    const sent: Array<Outgoing> = []
    const transport: SmtpTransport = { send: async (_c, m) => void sent.push(m) }
    const layer = SenderCloudflareWithSmtpFallback(binding, {
      config: { host: "mail.example.com", port: 465, username: "u", password: "p" },
      transport,
    }).pipe(Layer.provide(Ids.layerSequential("m")))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Sender).send(message)
      }).pipe(Effect.provide(layer)),
    )
    expect(result.messageId).toBe("m_1@mbprep.app")
    expect(sent).toHaveLength(1)
  })
})

describe("validate", () => {
  it(`refuses more than ${MAX_ATTACHMENTS} attachments`, async () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
      filename: `f${i}.txt`,
      type: "text/plain",
      content: new Uint8Array([1]),
      disposition: "attachment" as const,
    }))
    expect((await failure(validate({ ...message, attachments })))._tag).toBe("InvalidMessage")
  })

  it("counts attachments, base64-encoded, against the 5 MiB limit", async () => {
    const big = new Uint8Array(4 * 1024 * 1024)
    const error = await failure(
      validate({
        ...message,
        attachments: [
          { filename: "a.bin", type: "application/octet-stream", content: big, disposition: "attachment" },
        ],
      }),
    )
    expect(error._tag === "InvalidMessage" && error.reason).toMatch(/limit is 5242880/)
  })

  it("refuses a line break in the subject", async () => {
    expect((await failure(validate({ ...message, subject: "Hi\r\nBcc: x@y.z" })))._tag).toBe("InvalidMessage")
  })
})

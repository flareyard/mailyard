import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import {
  BlobStore,
  backoff,
  Ids,
  MAX_RECIPIENTS,
  MemoryOutbox,
  type Outgoing,
  Sender,
} from "../../src/kit/index.ts"

const SenderTest = Sender.layerMemory.pipe(Layer.provide(Ids.layerSequential("msg")))

const message = (overrides: Partial<Outgoing> = {}): Outgoing => ({
  from: { email: "hello@example.com", name: "Example" },
  to: [{ email: "ada@example.net" }],
  subject: "Welcome",
  text: "Hello",
  ...overrides,
})

const run = <A, E>(effect: Effect.Effect<A, E, Sender | MemoryOutbox>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(SenderTest)))

describe("Sender.layerMemory", () => {
  it("accepts a valid message and records it with an id", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const sender = yield* Sender
        const result = yield* sender.send(message())
        const sent = yield* (yield* MemoryOutbox).all
        return { result, sent }
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.result.messageId).toBe("msg_1")
      expect(exit.value.sent).toHaveLength(1)
      expect(exit.value.sent[0]?.subject).toBe("Welcome")
    }
  })

  it("rejects a message with no body", async () => {
    const { text: _text, ...noBody } = message()
    const exit = await run(
      Effect.gen(function* () {
        return yield* (yield* Sender).send(noBody)
      }),
    )
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("InvalidMessage")
  })

  it(`rejects more than ${MAX_RECIPIENTS} recipients before calling the provider`, async () => {
    const to = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({ email: `r${i}@example.net` }))
    const [first, ...rest] = to
    if (!first) throw new Error("unreachable")
    const exit = await run(
      Effect.gen(function* () {
        return yield* (yield* Sender).send(message({ to: [first, ...rest] }))
      }),
    )
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("51 recipients")
  })
})

describe("BlobStore.layerMemory", () => {
  it("puts, gets and deletes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* store.put("raw/a.eml", new TextEncoder().encode("Subject: hi"), "message/rfc822")
        const found = yield* store.get("raw/a.eml")
        yield* store.delete("raw/a.eml")
        const gone = yield* store.get("raw/a.eml")
        return { found, gone }
      }).pipe(Effect.provide(BlobStore.layerMemory)),
    )
    expect(Option.isSome(result.found)).toBe(true)
    if (Option.isSome(result.found)) {
      expect(new TextDecoder().decode(result.found.value.body)).toBe("Subject: hi")
      expect(result.found.value.contentType).toBe("message/rfc822")
    }
    expect(Option.isNone(result.gone)).toBe(true)
  })
})

describe("backoff", () => {
  it("retries a failing call exactly five times, then gives up", async () => {
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const count = yield* Ref.make(0)
        const failing = Ref.update(count, (n) => n + 1).pipe(Effect.andThen(Effect.fail("transient")))
        const fiber = yield* Effect.forkChild(Effect.retry(failing, backoff).pipe(Effect.exit))
        yield* TestClock.adjust("10 minutes")
        const exit = yield* Fiber.join(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        return yield* Ref.get(count)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(attempts).toBe(6)
  })

  it("stops at once when the error is not transient", async () => {
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const count = yield* Ref.make(0)
        const failing = Ref.update(count, (n) => n + 1).pipe(Effect.andThen(Effect.fail("permanent")))
        yield* Effect.retry(failing, { schedule: backoff, while: (e) => e === "transient" }).pipe(Effect.exit)
        return yield* Ref.get(count)
      }),
    )
    expect(attempts).toBe(1)
  })
})

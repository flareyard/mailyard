import { Effect, type Layer, ManagedRuntime } from "effect"
import type { Env } from "../Bindings.ts"
import { MAX_INBOUND_BYTES, receive } from "../inbound/pipeline.ts"
import { appLayer } from "../layers.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>
const runtimes = new WeakMap<Env, ManagedRuntime.ManagedRuntime<AppServices, never>>()

/** One runtime per bindings object; Workers pass the same `env` for the life of the isolate. */
export const runtimeFor = (env: Env) => {
  let runtime = runtimes.get(env)
  if (!runtime) {
    runtime = ManagedRuntime.make(appLayer(env))
    runtimes.set(env, runtime)
  }
  return runtime
}

/**
 * Email Routing's entry point, called once per envelope recipient. Store first: until the raw bytes
 * are in R2 a failure throws, so the sending MTA keeps the message and retries. After that the message
 * is accepted, bounced (no such address) or queued for another filing attempt; it is never dropped.
 */
export const handleEmail = async (message: ForwardableEmailMessage, env: Env) => {
  if (message.rawSize > MAX_INBOUND_BYTES) {
    message.setReject("Message exceeds the 25 MiB limit")
    return
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer())
  const outcome = await runtimeFor(env).runPromise(
    receive({ envelopeFrom: message.from, envelopeTo: message.to, raw, receivedAt: Date.now() }).pipe(
      Effect.tap((o) => Effect.logInfo(`inbound: ${o.outcome}${"id" in o && o.id ? ` ${o.id}` : ""}`)),
    ),
  )
  if (outcome.outcome === "rejected") message.setReject(outcome.reason)
  return outcome
}

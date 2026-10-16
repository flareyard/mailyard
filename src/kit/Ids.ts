import { Context, Effect, Layer } from "effect"

/** Identifier generation, swappable so tests get stable ids. */
export class Ids extends Context.Service<
  Ids,
  {
    readonly next: Effect.Effect<string>
  }
>()("mailflare/kit/Ids") {
  /** Time-ordered ids: a millisecond timestamp in base 36 followed by 80 random bits, so they sort by creation. */
  static readonly layer = Layer.succeed(
    Ids,
    Ids.of({
      next: Effect.sync(() => {
        const random = crypto.getRandomValues(new Uint8Array(10))
        const tail = Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("")
        return `${Date.now().toString(36).padStart(9, "0")}${tail}`
      }),
    }),
  )

  /** Sequential ids with a prefix, for deterministic tests. */
  static readonly layerSequential = (prefix = "id") =>
    Layer.effect(
      Ids,
      Effect.sync(() => {
        let n = 0
        return Ids.of({ next: Effect.sync(() => `${prefix}_${++n}`) })
      }),
    )
}

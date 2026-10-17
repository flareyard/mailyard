import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"

export interface Blob {
  readonly body: Uint8Array
  readonly contentType: string | undefined
  readonly size: number
}

export class BlobStoreError extends Schema.TaggedError<BlobStoreError>()("BlobStoreError", {
  operation: Schema.Literals(["put", "get", "delete"]),
  key: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Object storage for raw mail, attachments, uploads and exports. R2 on Cloudflare, memory in tests. */
export class BlobStore extends Context.Service<
  BlobStore,
  {
    put(key: string, body: Uint8Array, contentType?: string): Effect.Effect<void, BlobStoreError>
    get(key: string): Effect.Effect<Option.Option<Blob>, BlobStoreError>
    delete(key: string): Effect.Effect<void, BlobStoreError>
  }
>()("mailyard/kit/BlobStore") {
  static readonly layerR2 = (bucket: R2Bucket) =>
    Layer.succeed(
      BlobStore,
      BlobStore.of({
        put: (key, body, contentType) =>
          Effect.tryPromise({
            try: () => bucket.put(key, body, contentType ? { httpMetadata: { contentType } } : undefined),
            catch: (cause) => new BlobStoreError({ operation: "put", key, cause }),
          }).pipe(Effect.asVoid),
        get: (key) =>
          Effect.tryPromise({
            try: async () => {
              const object = await bucket.get(key)
              if (!object) return Option.none<Blob>()
              const body = new Uint8Array(await object.arrayBuffer())
              return Option.some<Blob>({
                body,
                contentType: object.httpMetadata?.contentType,
                size: body.length,
              })
            },
            catch: (cause) => new BlobStoreError({ operation: "get", key, cause }),
          }),
        delete: (key) =>
          Effect.tryPromise({
            try: () => bucket.delete(key),
            catch: (cause) => new BlobStoreError({ operation: "delete", key, cause }),
          }),
      }),
    )

  static readonly layerMemory = Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const store = yield* Ref.make(new Map<string, Blob>())
      return BlobStore.of({
        put: (key, body, contentType) =>
          Ref.update(store, (m) => new Map(m).set(key, { body, contentType, size: body.length })),
        get: (key) => Ref.get(store).pipe(Effect.map((m) => Option.fromNullishOr(m.get(key)))),
        delete: (key) =>
          Ref.update(store, (m) => {
            const next = new Map(m)
            next.delete(key)
            return next
          }),
      })
    }),
  )
}

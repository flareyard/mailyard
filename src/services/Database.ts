import { drizzle } from "drizzle-orm/d1"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import * as schema from "../db/schema.ts"

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Db = ReturnType<typeof drizzle<typeof schema>>

/** The account-wide D1 database, behind a service so handlers never touch the binding directly. */
export class Database extends Context.Service<
  Database,
  {
    readonly db: Db
    readonly ping: Effect.Effect<void, DatabaseError>
    query<A>(operation: string, run: (db: Db) => Promise<A>): Effect.Effect<A, DatabaseError>
  }
>()("mailyard/Database") {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      const { DB } = yield* Bindings
      const db = drizzle(DB, { schema })
      const query = <A>(operation: string, run: (db: Db) => Promise<A>) =>
        Effect.tryPromise({ try: () => run(db), catch: (cause) => new DatabaseError({ operation, cause }) })
      return Database.of({
        db,
        query,
        ping: Effect.tryPromise({
          try: () => DB.prepare("select 1 as ok").first(),
          catch: (cause) => new DatabaseError({ operation: "ping", cause }),
        }).pipe(Effect.asVoid),
      })
    }),
  )
}

/**
 * D1 binds at most 100 parameters a statement (HAL-3425). A list that can grow (ids from a page, a
 * graph, a request) goes in chunks of 90, leaving room for the statement's other parameters.
 * test/d1Params.test.ts checks every `inArray` in src is chunked, a literal, or marked bounded.
 */
export const D1_MAX_PARAMS = 90

export const chunksOf = <T>(items: ReadonlyArray<T>, size: number = D1_MAX_PARAMS): Array<Array<T>> => {
  const out: Array<Array<T>> = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Runs `run` over `items` a chunk at a time and joins what each returns. Empty `items` runs nothing. */
export const queryIn = <T, A>(
  operation: string,
  items: ReadonlyArray<T>,
  run: (db: Db, chunk: Array<T>) => Promise<ReadonlyArray<A>>,
) =>
  Effect.gen(function* () {
    const database = yield* Database
    const out: Array<A> = []
    for (const chunk of chunksOf(items))
      out.push(...(yield* database.query(operation, (db) => run(db, chunk))))
    return out
  })

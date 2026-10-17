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

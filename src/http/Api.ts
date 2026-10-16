import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  app: Schema.Literal("mail"),
  version: Schema.String,
  database: Schema.Literal("ok"),
})

export class Unhealthy extends Schema.TaggedError<Unhealthy>()(
  "Unhealthy",
  { database: Schema.Literal("unreachable") },
  { httpApiStatus: 503 },
) {}

/** The platform's health check calls this before it marks a deploy as running (manifest `health`). */
export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/healthz", { success: Health, error: Unhealthy }),
) {}

/** The mail app's HTTP API. The UI contract (docs/plans/email-ui.html#contract) grows here, group by group. */
export class MailApi extends HttpApi.make("mail")
  .add(SystemApi)
  .annotateMerge(OpenApi.annotations({ title: "Flareyard Mail API" })) {}

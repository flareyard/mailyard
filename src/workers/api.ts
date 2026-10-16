import { env } from "cloudflare:workers"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Bindings, type Env } from "../Bindings.ts"
import { MailApi } from "../http/Api.ts"
import { SystemHandlers } from "../http/handlers.ts"
import { Database } from "../services/Database.ts"

const Services = Database.layer.pipe(Layer.provide(Layer.succeed(Bindings, env)))

const Routes = HttpApiBuilder.layer(MailApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(SystemHandlers),
  Layer.provide(Services),
  Layer.provide(HttpServer.layerServices),
)

// Built once per isolate; Workers reuse an isolate across requests.
const { handler } = HttpRouter.toWebHandler(Routes, { disableLogger: true })

export default {
  fetch: (request) => handler(request),
} satisfies ExportedHandler<Env>

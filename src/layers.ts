import { BlobStore, Ids, Sender, SenderCloudflareWithSmtpFallback } from "@flareyard/kit"
import { workerSmtpTransport } from "@flareyard/kit/smtp-worker"
import { Layer } from "effect"
import { Bindings, type Env } from "./Bindings.ts"
import { Database } from "./services/Database.ts"
import { SendQueue } from "./services/SendQueue.ts"

/** Email Service with optional SMTP fallback, or the in-memory sender when MAILFLARE_SENDER=memory. */
const senderLayer = (env: Env) => {
  if (env.MAILFLARE_SENDER === "memory") return Sender.layerMemory
  if (!env.EMAIL)
    throw new Error("No EMAIL (send_email) binding; set MAILFLARE_SENDER=memory for local tests.")
  const smtp =
    env.SMTP_HOST && env.SMTP_USERNAME && env.SMTP_PASSWORD
      ? {
          config: {
            host: env.SMTP_HOST,
            port: Number(env.SMTP_PORT ?? "465"),
            username: env.SMTP_USERNAME,
            password: env.SMTP_PASSWORD,
          },
          transport: workerSmtpTransport,
        }
      : undefined
  return SenderCloudflareWithSmtpFallback(env.EMAIL, smtp)
}

/** Every service the app's handlers and consumers use, built from the Worker's bindings. */
export const appLayer = (env: Env) => {
  const bindings = Layer.succeed(Bindings, env)
  return Layer.mergeAll(
    Database.layer,
    SendQueue.layer,
    BlobStore.layerR2(env.STORE),
    senderLayer(env).pipe(Layer.provideMerge(Ids.layer)),
  ).pipe(Layer.provideMerge(bindings))
}

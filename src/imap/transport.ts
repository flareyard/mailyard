import { connect } from "cloudflare:sockets"
import type { Transport } from "./client.ts"

/** IMAP over implicit TLS (port 993) with Workers `connect()`. One per step: sockets can't outlive a request. */
export const tlsTransport = async (host: string, port: number): Promise<Transport> => {
  const socket = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false })
  await socket.opened
  const reader = socket.readable.getReader()
  const writer = socket.writable.getWriter()
  return {
    write: (bytes) => writer.write(bytes),
    read: async () => {
      const { value, done } = await reader.read()
      return done ? null : (value as Uint8Array)
    },
    close: async () => {
      await writer.close().catch(() => {})
      await socket.close().catch(() => {})
    },
  }
}

#!/usr/bin/env bun
/**
 * Puts the repo's template library (src/templates/library) into a running Mailyard (HAL-3304).
 *
 *   MAILYARD_URL=https://… MAILYARD_KEY=… bun run templates:install [--publish] [--dry-run] [slug…]
 *
 * Templates are matched by name: a new one is created, an existing one gets a new draft version. Drafts
 * send nothing; `--publish` publishes them, which is what automations and `POST /v1/send` use.
 * With slugs, only those are installed. `--dry-run` says what it would do and changes nothing.
 * The key needs the `admin` scope (templates are account-wide).
 */
import { LIBRARY, toSource } from "../../src/templates/library/index.ts"

const args = process.argv.slice(2)
const publish = args.includes("--publish")
const dryRun = args.includes("--dry-run")
const slugs = args.filter((a) => !a.startsWith("--"))
const base = (process.env.MAILYARD_URL ?? "").replace(/\/+$/, "")
const key = process.env.MAILYARD_KEY ?? ""
if (!base || !key) throw new Error("Set MAILYARD_URL and MAILYARD_KEY.")

const unknown = slugs.filter((s) => !LIBRARY.some((t) => t.slug === s))
if (unknown.length > 0)
  throw new Error(
    `No template called ${unknown.join(", ")}. The library has ${LIBRARY.map((t) => t.slug).join(", ")}.`,
  )
const chosen = slugs.length > 0 ? LIBRARY.filter((t) => slugs.includes(t.slug)) : LIBRARY

const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "user-agent": "mailyard-templates-install/1",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

const existing = await api<{ templates: Array<{ id: string; name: string }> }>("GET", "/v1/templates")
for (const t of chosen) {
  const source = toSource(t)
  const body = { subject: source.subject, source: source.source, text: source.text }
  const found = existing.templates.find((x) => x.name === t.name)
  const action = found ? "update" : "create"
  if (dryRun) {
    console.log(`${t.slug}: would ${action} "${t.name}"${publish ? " and publish it" : " as a draft"}`)
    continue
  }
  let id: string
  if (found) {
    await api("PUT", `/v1/templates/${found.id}/draft`, body)
    if (publish) await api("POST", `/v1/templates/${found.id}/publish`)
    id = found.id
  } else {
    id = (
      await api<{ id: string }>("POST", "/v1/templates", { name: t.name, kind: t.kind, ...body, publish })
    ).id
  }
  console.log(`${t.slug}: ${action}d "${t.name}" (${id})${publish ? ", published" : ", draft"}`)
}

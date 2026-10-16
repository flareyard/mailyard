import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import { ADMIN, call, createKey, json } from "../helpers.ts"

let secret = ""
beforeAll(async () => {
  secret = (await createKey("secret")).key
})

const admin = (path: string, method: string, body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

const blocksDoc = {
  preheader: "Your code is {{ code }}",
  label: "Sign-in",
  blocks: [
    { type: "heading", text: "Hello **{{ name ?? 'there' }}**" },
    { type: "otp", code: "{{ code }}" },
    { type: "button", label: "Open {{ app }}", url: "https://example.com/open?u={{ email }}" },
    { type: "paragraph", text: 'Plan: {{ plan ?? "free" }}' },
  ],
  footer: {
    reason: "You asked to sign in.",
    links: [{ label: "Preferences", url: "https://example.com/p" }],
  },
}

type Detail = {
  id: string
  publishedVersion: number | null
  latestVersion: number
  hasUnpublishedChanges: boolean
}
type Rendered = {
  subject: string
  html: string
  text: string
  size: number
  withinLimit: boolean
  variables: { used: Array<string>; required: Array<string>; missing: Array<string> }
}

describe("brand", () => {
  it("is stored, validated, and used by block templates", async () => {
    const bad = await admin("/v1/settings/brand", "PUT", { name: "Acme", siteUrl: "not a url", tagline: "x" })
    expect(bad.status).toBe(400)
    const put = await admin("/v1/settings/brand", "PUT", {
      name: "Acme",
      siteUrl: "https://acme.test",
      tagline: "Rockets, mostly.",
      logoUrl: "https://acme.test/logo.png",
      colors: { fg: "#101010" },
    })
    expect(put.status).toBe(200)
    expect(await json(await call("/v1/settings/brand", { key: secret }))).toMatchObject({ name: "Acme" })
  })
})

describe("block templates", () => {
  it("render in the brand with data filled in, escaped, and missing variables reported", async () => {
    const created = await admin("/v1/templates", "POST", {
      name: "sign-in",
      kind: "blocks",
      subject: "{{ code }} is your {{ app }} code",
      source: JSON.stringify(blocksDoc),
      publish: true,
    })
    expect(created.status).toBe(200)
    const { id } = await json<Detail>(created)
    const rendered = await json<Rendered>(
      await call(`/v1/templates/${id}/render`, {
        method: "POST",
        key: secret,
        json: { data: { code: "123456", name: "<Ada>", email: "ada@example.net" } },
      }),
    )
    expect(rendered.subject).toBe("123456 is your  code")
    expect(rendered.html).toContain("<title>Acme</title>")
    expect(rendered.html).toContain('src="https://acme.test/logo.png"')
    expect(rendered.html).toContain("&lt;Ada&gt;")
    expect(rendered.html).not.toContain("<Ada>")
    expect(rendered.html).toContain("Acme · Rockets, mostly.")
    expect(rendered.text).toContain("Your code: 123 456")
    expect(rendered.text).toContain("Plan: free")
    expect(rendered.withinLimit).toBe(true)
    expect(rendered.variables.used).toEqual(["app", "code", "email", "name", "plan"])
    expect(rendered.variables.required).toEqual(["app", "code", "email"])
    expect(rendered.variables.missing).toEqual(["app"])
  })

  it("refuse a blocks document that isn't valid, or links that aren't http(s)", async () => {
    const notJson = await admin("/v1/templates", "POST", {
      name: "broken",
      kind: "blocks",
      subject: "s",
      source: "{",
    })
    expect(notJson.status).toBe(400)
    const script = await admin("/v1/templates", "POST", {
      name: "script-link",
      kind: "blocks",
      subject: "s",
      source: JSON.stringify({
        ...blocksDoc,
        blocks: [{ type: "button", label: "x", url: "javascript:alert(1)" }],
      }),
    })
    expect(script.status).toBe(400)
  })
})

describe("versions", () => {
  it("send the published version while a draft is edited, then publish and roll back", async () => {
    const created = await json<Detail>(
      await admin("/v1/templates", "POST", {
        name: "receipt",
        kind: "html",
        subject: "Receipt v1",
        source: "<p>v1 {{ amount }}</p>",
      }),
    )
    const sendIt = () =>
      call("/v1/send", {
        method: "POST",
        key: secret,
        json: {
          to: "buyer@example.net",
          template: "receipt",
          from: "billing@mailflare.test",
          data: { amount: "₦4,000" },
        },
      })
    // Never published: a send can't use it yet.
    expect((await sendIt()).status).toBe(404)

    const v1 = await json<Detail>(await admin(`/v1/templates/${created.id}/publish`, "POST"))
    expect(v1.publishedVersion).toBe(1)

    const draft = await json<Detail>(
      await admin(`/v1/templates/${created.id}/draft`, "PUT", {
        subject: "Receipt v2",
        source: "<p>v2 {{ amount }}</p>",
      }),
    )
    expect(draft).toMatchObject({ latestVersion: 2, publishedVersion: 1, hasUnpublishedChanges: true })

    const subjectOfLastSend = async () => {
      const { data } = await json<{ data: { emails: Array<{ email: string }> } }>(await sendIt())
      const row = await env.DB.prepare("select subject, template_version from messages_out where id = ?")
        .bind(data.emails[0]?.email)
        .first<{ subject: string; template_version: number }>()
      return row
    }
    expect(await subjectOfLastSend()).toEqual({ subject: "Receipt v1", template_version: 1 })

    await admin(`/v1/templates/${created.id}/publish`, "POST")
    expect(await subjectOfLastSend()).toEqual({ subject: "Receipt v2", template_version: 2 })

    const rolled = await json<Detail>(
      await admin(`/v1/templates/${created.id}/rollback`, "POST", { version: 1 }),
    )
    expect(rolled).toMatchObject({ latestVersion: 3, publishedVersion: 3 })
    expect(await subjectOfLastSend()).toEqual({ subject: "Receipt v1", template_version: 3 })

    const detail = await json<{ versions: Array<{ version: number }> }>(
      await call(`/v1/templates/${created.id}`, { key: secret }),
    )
    expect(detail.versions.map((v) => v.version)).toEqual([3, 2, 1])
  })

  it("stop sends once a template is archived", async () => {
    const t = await json<Detail>(
      await admin("/v1/templates", "POST", {
        name: "old",
        kind: "html",
        subject: "Old",
        source: "<p>old</p>",
        publish: true,
      }),
    )
    await admin(`/v1/templates/${t.id}`, "DELETE")
    const response = await call("/v1/send", {
      method: "POST",
      key: secret,
      json: { to: "x@example.net", template: t.id, from: "hello@mailflare.test" },
    })
    expect(response.status).toBe(404)
  })
})

describe("access", () => {
  it("lets a secret key read and render, but only an admin key change templates or the brand", async () => {
    expect((await call("/v1/templates", { key: secret })).status).toBe(200)
    expect(
      (
        await call("/v1/templates", {
          method: "POST",
          key: secret,
          json: { name: "n", kind: "html", subject: "s", source: "b" },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await call("/v1/settings/brand", {
          method: "PUT",
          key: secret,
          json: { name: "x", siteUrl: "https://x", tagline: "" },
        })
      ).status,
    ).toBe(403)
  })

  it("previews an unsaved template", async () => {
    const response = await call("/v1/templates/preview", {
      method: "POST",
      key: secret,
      json: {
        kind: "html",
        subject: "Hi {{ name }}",
        source: "<p>Hi {{ name }}</p>",
        data: { name: "Kemi" },
      },
    })
    expect(await json<Rendered>(response)).toMatchObject({ subject: "Hi Kemi", text: "Hi Kemi" })
  })
})

/**
 * Settings → Brand (design: brand, brand-default, brand-contrast-refused, brand-logo-uploaded,
 * brand-logo-svg-refused, brand-logo-too-big; HANDOFF-ops §30, HAL-3376). Name, site, tagline, logo (uploaded
 * and hosted by this Mailyard), the ten colour keys and fonts, a contrast check that runs the API's own six
 * pairs before you save, and a preview of the public pages in the brand.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { fmtBytes } from "../../ops/format.ts"
import { BuiltPill } from "../../ops/kit.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import {
  COLOR_KEYS,
  COLOR_LABEL,
  type ColorKey,
  type Colors,
  changedFields,
  cleanColors,
  contrastPairs,
  contrastProblem,
  DEFAULT_COLORS,
  fmtRatio,
  isHex,
  logoProblem,
  unsavedLine,
} from "../logic.ts"
import { type Brand, brandQuery, complianceQuery } from "../queries.ts"
import { SaveBar, SectionHead } from "../ui.tsx"
import { previewDoc } from "./preview.ts"

/** The order the design lays the colour fields out in, two to a row. */
const ORDER: ColorKey[] = ["bg", "surface", "fg", "body", "muted", "border", "indigo", "lime", "red", "white"]

type Form = {
  name: string
  siteUrl: string
  tagline: string
  logoUrl: string
  fontsHref: string
  colors: Record<ColorKey, string>
  display: string
  body: string
  mono: string
}

const formOf = (b: Brand): Form => ({
  name: b.name,
  siteUrl: b.siteUrl,
  tagline: b.tagline,
  logoUrl: b.logoUrl ?? "",
  fontsHref: b.fontsHref ?? "",
  colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, b.colors?.[k] ?? ""])) as Record<ColorKey, string>,
  display: b.fonts?.display ?? "",
  body: b.fonts?.body ?? "",
  mono: b.fonts?.mono ?? "",
})

const LABELS: Partial<Record<keyof Form, string>> = {
  name: "name",
  siteUrl: "website",
  tagline: "tagline",
  logoUrl: "logo",
  fontsHref: "fonts",
  colors: "colours",
  display: "fonts",
  body: "fonts",
  mono: "fonts",
}

type Upload = { id: string; name: string; size: number; type: string; preview: string }

export function BrandPage() {
  const q = useQuery(brandQuery)
  return (
    <>
      <SectionHead title="Brand" sub="Your name, logo, colours and fonts on every page recipients see." />
      {q.isPending ? (
        <div className="panel">
          <div className="panel-body">
            <PanelSkeleton rows={8} />
          </div>
        </div>
      ) : q.isError ? (
        <div className="panel is-error">
          <div className="panel-body">
            <PanelError error={q.error} onRetry={() => q.refetch()} what="The brand didn’t load" />
          </div>
        </div>
      ) : (
        <BrandForm brand={q.data} />
      )}
    </>
  )
}

function BrandForm({ brand }: { brand: Brand }) {
  const qc = useQueryClient()
  const initial = useMemo(() => formOf(brand), [brand])
  const [f, setF] = useState(initial)
  useEffect(() => setF(initial), [initial])
  const [upload, setUpload] = useState<Upload | null>(null)
  const [logoError, setLogoError] = useState<{ name: string; size: number; message: string } | null>(null)
  const [serverError, setServerError] = useState<{ field: string | null; message: string } | null>(null)
  const [page, setPage] = useState<"preferences" | "signup">("preferences")
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const compliance = useQuery(complianceQuery)

  const colors: Colors = cleanColors(f.colors)
  const pairs = contrastPairs(colors)
  const problem = contrastProblem(colors)
  const badHex = COLOR_KEYS.filter((k) => f.colors[k].trim() && !isHex(f.colors[k].trim()))
  const changed = [...changedFields(initial, f, LABELS), ...(upload ? ["logo"] : [])].filter(
    (v, i, a) => a.indexOf(v) === i,
  )
  const siteBad = !/^https?:\/\//.test(f.siteUrl.trim())
  const fontsBad = f.fontsHref.trim() !== "" && !/^https:\/\//.test(f.fontsHref.trim())
  const blocked = Boolean(problem) || badHex.length > 0 || !f.name.trim() || siteBad || fontsBad
  const errorField = serverError?.field ?? problem?.field ?? null
  const setColor = (k: ColorKey, v: string) => {
    setServerError(null)
    setF((p) => ({ ...p, colors: { ...p.colors, [k]: v } }))
  }

  const uploadLogo = useMutation({
    mutationFn: async (file: File) =>
      unwrap(
        api.POST("/v1/uploads", {
          params: { query: { filename: file.name.replace(/[/\\]/g, "_") } },
          body: file as unknown as string,
          bodySerializer: (b: unknown) => b as BodyInit,
          headers: { "content-type": file.type || "application/octet-stream" },
        }),
      ),
    onSuccess: (r, file) =>
      setUpload({
        id: r.id,
        name: file.name,
        size: file.size,
        type: file.type,
        preview: URL.createObjectURL(file),
      }),
    onError: (e, file) =>
      setLogoError({
        name: file.name,
        size: file.size,
        message: e instanceof Error ? e.message : "The upload failed.",
      }),
  })
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0]
    e.target.value = ""
    if (!chosen) return
    const p = logoProblem(chosen)
    if (p) {
      setLogoError({ name: chosen.name, size: chosen.size, message: p })
      setUpload(null)
      return
    }
    setLogoError(null)
    uploadLogo.mutate(chosen)
  }

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/v1/settings/brand", {
          body: {
            name: f.name.trim(),
            siteUrl: f.siteUrl.trim(),
            tagline: f.tagline,
            ...(f.logoUrl.trim() && !upload ? { logoUrl: f.logoUrl.trim() } : {}),
            ...(f.fontsHref.trim() ? { fontsHref: f.fontsHref.trim() } : {}),
            colors,
            fonts: {
              ...(f.display.trim() ? { display: f.display.trim() } : {}),
              ...(f.body.trim() ? { body: f.body.trim() } : {}),
              ...(f.mono.trim() ? { mono: f.mono.trim() } : {}),
            },
            ...(upload ? { logoUploadId: upload.id } : {}),
          },
        }),
      ),
    onSuccess: (saved) => {
      setUpload(null)
      setSavedAt(Date.now())
      qc.setQueryData(brandQuery.queryKey, { ...brand, ...saved } as Brand)
      toast({ title: "Brand saved", sub: "Every public page and new email uses it now" })
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 400) {
        const field = typeof e.body.field === "string" ? e.body.field : null
        setServerError({ field, message: e.message })
        if (field === "logoUploadId")
          setLogoError({ name: upload?.name ?? "logo", size: upload?.size ?? 0, message: e.message })
      } else
        setServerError({
          field: null,
          message: e instanceof Error ? e.message : "Mailyard couldn’t be reached.",
        })
    },
  })

  const usingDefaults = !brand.logoUrl && !Object.values(brand.colors ?? {}).some(Boolean)
  const saveLine = blocked
    ? problem
      ? `Not saved: fix the ${COLOR_LABEL[problem.field.replace("colors.", "") as ColorKey].toLowerCase().split(" (")[0]}`
      : badHex.length
        ? "Colours are #rrggbb"
        : siteBad
          ? "The website starts with https://"
          : fontsBad
            ? "The fonts stylesheet must be https"
            : "Give the brand a name"
    : changed.length
      ? unsavedLine(changed)
      : savedAt
        ? "Saved just now"
        : usingDefaults
          ? "Using defaults"
          : "No unsaved changes"
  const logoShown = upload?.preview ?? f.logoUrl

  return (
    <>
      {serverError && serverError.field !== "logoUploadId" ? (
        <div className="callout callout-error" role="alert" style={{ marginBottom: 12 }}>
          <Icon name="x-circle" />
          <span>
            <b>Not saved.</b> {serverError.message}
          </span>
        </div>
      ) : null}
      <div className="brand-grid">
        <section
          className="panel"
          data-endpoint="GET /v1/settings/brand · PUT /v1/settings/brand · POST /v1/uploads?filename= (built, HAL-3376)"
          data-od-id="panel-brand-form"
          aria-labelledby="h-brand-form"
        >
          <header className="panel-head">
            <h2 className="panel-title" id="h-brand-form">
              Brand
            </h2>
            <div className="cluster">
              <BuiltPill issue="HAL-3376" />
            </div>
          </header>
          <div className="panel-body">
            <div className="stack stack-16">
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="b-name">
                    Name
                  </label>
                  <input
                    className="input"
                    id="b-name"
                    value={f.name}
                    onChange={(e) => setF({ ...f, name: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="b-site">
                    Website
                  </label>
                  <input
                    className="input mono"
                    id="b-site"
                    value={f.siteUrl}
                    onChange={(e) => setF({ ...f, siteUrl: e.target.value })}
                    aria-invalid={siteBad ? true : undefined}
                  />
                  {siteBad ? (
                    <span className="field-error">
                      <Icon name="x-circle" />
                      Starts with https:// or http://.
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor="b-tag">
                  Tagline
                </label>
                <input
                  className="input"
                  id="b-tag"
                  value={f.tagline}
                  onChange={(e) => setF({ ...f, tagline: e.target.value })}
                />
              </div>
              <div className="field">
                <span className="label">Logo</span>
                <input
                  ref={file}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={pick}
                />
                {logoError ? (
                  <>
                    <button
                      type="button"
                      className="dropzone is-invalid"
                      style={{ padding: 16 }}
                      data-od-id="logo-drop"
                      onClick={() => file.current?.click()}
                      aria-describedby="logo-err"
                    >
                      <Icon name="upload" />
                      <span>
                        <b>{logoError.name}</b>
                        {logoError.size ? ` · ${fmtBytes(logoError.size)}` : ""} · choose another
                      </span>
                    </button>
                    <span className="field-error" id="logo-err">
                      <Icon name="x-circle" />
                      {logoError.message}
                    </span>
                  </>
                ) : logoShown ? (
                  <div className="logo-hosted" data-od-id="logo-hosted">
                    <img src={logoShown} alt={`${f.name} logo`} width={44} height={44} />
                    <div className="stack stack-4" style={{ minWidth: 0 }}>
                      {upload ? (
                        <>
                          <span className="t-small">
                            <b>{upload.name}</b> · {fmtBytes(upload.size)} ·{" "}
                            {upload.type.replace("image/", "").toUpperCase()}
                          </span>
                          <span className="hint">
                            Uploaded. Save the brand to host it here; it then shows in emails and on every
                            public page.
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="mono t-small" style={{ overflowWrap: "anywhere" }}>
                            {f.logoUrl}
                          </span>
                          <span className="hint">
                            {f.logoUrl.includes("/brand/logo/")
                              ? "Hosted by this Mailyard under its hash; it shows in emails and on every public page."
                              : "Set by URL before uploads existed. Upload a PNG to host it here instead."}
                          </span>
                        </>
                      )}
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      onClick={() => file.current?.click()}
                      disabled={uploadLogo.isPending}
                    >
                      {uploadLogo.isPending
                        ? "Uploading…"
                        : f.logoUrl.includes("/brand/logo/") || upload
                          ? "Replace"
                          : "Upload"}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="dropzone"
                    style={{ padding: 16 }}
                    onClick={() => file.current?.click()}
                    disabled={uploadLogo.isPending}
                  >
                    <Icon name="upload" />
                    <span>
                      <b>{uploadLogo.isPending ? "Uploading…" : "Upload a logo"}</b> · PNG, JPEG, WebP or GIF,
                      up to 1 MiB
                    </span>
                  </button>
                )}
                {logoError ? (
                  <span className="hint">
                    PNG, JPEG, WebP or GIF, up to 1 MiB, checked by the file’s bytes. SVG isn’t accepted
                    because it can carry script.
                  </span>
                ) : null}
              </div>
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label" style={{ marginBottom: 8 }}>
                  Colours · #rrggbb; empty uses the default
                </legend>
                <div className="stack stack-12">
                  {[0, 2, 4, 6, 8].map((i) => (
                    <div key={i} className="field-row">
                      {ORDER.slice(i, i + 2).map((k) => (
                        <ColorField
                          key={k}
                          k={k}
                          value={f.colors[k]}
                          onChange={(v) => setColor(k, v)}
                          error={
                            errorField === `colors.${k}`
                              ? ((serverError?.field === `colors.${k}`
                                  ? serverError.message
                                  : problem?.message) ?? null)
                              : f.colors[k].trim() && !isHex(f.colors[k].trim())
                                ? "Use #rrggbb, like #2f5bd8."
                                : null
                          }
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </fieldset>
              <div className="contrast-check" data-od-id="contrast-hint">
                <span className="label">Contrast, before you save</span>
                <ul>
                  {pairs.map((p) => (
                    <li key={p.what} className={p.ok ? "is-ok" : "is-bad"}>
                      <Icon name={p.ok ? "check-circle" : "x-circle"} />
                      <span>
                        {p.what} <b className="num">{fmtRatio(p.ratio)}</b>
                        {p.ok ? null : " · needs 4.5:1"}
                      </span>
                    </li>
                  ))}
                </ul>
                <span className="hint">
                  Saving is refused until these reach AA (4.5:1). Checked the way the API checks it, on your
                  colours merged over the defaults.
                </span>
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="b-fdisplay">
                    Heading font <span className="mono opt">fonts.display</span>
                  </label>
                  <input
                    className="input"
                    id="b-fdisplay"
                    value={f.display}
                    placeholder="Default display"
                    onChange={(e) => setF({ ...f, display: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="b-fbody">
                    Body font <span className="mono opt">fonts.body</span>
                  </label>
                  <input
                    className="input"
                    id="b-fbody"
                    value={f.body}
                    placeholder="Default body"
                    onChange={(e) => setF({ ...f, body: e.target.value })}
                  />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="b-fmono">
                    Mono font <span className="mono opt">fonts.mono</span>
                  </label>
                  <input
                    className="input"
                    id="b-fmono"
                    value={f.mono}
                    placeholder="Default mono"
                    onChange={(e) => setF({ ...f, mono: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="b-fh">
                    Fonts stylesheet <span className="opt">· optional</span>
                  </label>
                  <input
                    className="input mono"
                    id="b-fh"
                    value={f.fontsHref}
                    placeholder="https://fonts.googleapis.com/css2?family=…"
                    aria-invalid={fontsBad ? true : undefined}
                    onChange={(e) => setF({ ...f, fontsHref: e.target.value })}
                  />
                  {fontsBad ? (
                    <span className="field-error">
                      <Icon name="x-circle" />
                      An https:// stylesheet.
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </section>
        <section
          className="panel"
          data-endpoint="renders /u/:token and /f/:formId with these values (built, raw route, not in OpenAPI)"
          data-od-id="panel-brand-preview"
          aria-labelledby="h-brand-preview"
        >
          <header className="panel-head">
            <h2 className="panel-title" id="h-brand-preview">
              Preview
            </h2>
            <div className="cluster">
              <span className="panel-meta">unsaved changes included</span>
            </div>
          </header>
          <div className="panel-body">
            <div className="stack stack-12">
              {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
              <div className="seg" role="group" aria-label="Preview page">
                <button
                  type="button"
                  aria-pressed={page === "preferences"}
                  onClick={() => setPage("preferences")}
                >
                  Email preferences · /u
                </button>
                <button type="button" aria-pressed={page === "signup"} onClick={() => setPage("signup")}>
                  Signup form
                </button>
              </div>
              <div className="mini-browser">
                <div className="mini-browser-bar">
                  <Icon name="lock" />
                  <span>
                    {window.location.host}
                    {page === "preferences" ? "/u/eyJ0…" : "/f/frm_…"}
                  </span>
                </div>
                <iframe
                  title={`Preview of the ${page === "preferences" ? "email preferences page" : "signup form"} with this brand`}
                  sandbox=""
                  srcDoc={previewDoc(
                    {
                      name: f.name,
                      logoUrl: logoShown?.startsWith("blob:") ? undefined : logoShown || undefined,
                      fontsHref: f.fontsHref || undefined,
                      colors,
                      fonts: { display: f.display || undefined, body: f.body || undefined },
                      postalAddress: compliance.data?.postalAddress,
                      privacyUrl: compliance.data?.privacyUrl,
                    },
                    page,
                  )}
                />
              </div>
              <span className="hint">
                Defaults fill any empty colour: the accent is{" "}
                <span className="mono">{DEFAULT_COLORS.indigo}</span> and the page{" "}
                <span className="mono">{DEFAULT_COLORS.bg}</span>.
              </span>
            </div>
          </div>
        </section>
      </div>
      <SaveBar line={saveLine} tone={blocked ? "error" : "muted"}>
        {changed.length ? (
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              setF(initial)
              setUpload(null)
              setLogoError(null)
              setServerError(null)
            }}
          >
            Discard
          </button>
        ) : null}
        <button
          className="btn btn-primary"
          type="button"
          aria-disabled={blocked || save.isPending || !changed.length ? true : undefined}
          onClick={() => !blocked && !save.isPending && changed.length && save.mutate()}
          data-endpoint="PUT /v1/settings/brand"
        >
          {save.isPending ? "Saving…" : "Save brand"}
        </button>
      </SaveBar>
    </>
  )
}

function ColorField({
  k,
  value,
  onChange,
  error,
}: {
  k: ColorKey
  value: string
  onChange: (v: string) => void
  error: string | null
}) {
  const v = value.trim()
  const sw = isHex(v) ? v : DEFAULT_COLORS[k]
  return (
    <div className="field">
      <label className="label" htmlFor={`c-${k}`}>
        {COLOR_LABEL[k]} <span className="mono opt">colors.{k}</span>
      </label>
      <div className="swatch-input">
        <span className="sw" style={{ ["--sw" as string]: sw }} aria-hidden="true" />
        <input
          className="input mono"
          id={`c-${k}`}
          value={value}
          placeholder={`Default ${DEFAULT_COLORS[k]}`}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `c-${k}-err` : undefined}
        />
      </div>
      {error ? (
        <span className="field-error" id={`c-${k}-err`}>
          <Icon name="x-circle" />
          {error}
        </span>
      ) : null}
    </div>
  )
}

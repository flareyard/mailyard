/**
 * The allow and block lists (senders.html, and the Senders panel on rules.html): who skips the spam check
 * and who goes straight to Spam. GET/POST …/senders, DELETE …/senders/{value}. On the Senders page a third
 * tab lists the senders whose remote images always show (HAL-3369): GET/POST …/image-senders,
 * DELETE …/image-senders/{value}, the same list a message's "Always show from …" adds to.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { useMail } from "../context.tsx"
import { imageSenderValue, relativeShort, SOURCE_WORDS, senderValue } from "./logic.ts"
import { pageKeys } from "./shared.tsx"
import type { ImageSender, ImageSenderList, Sender, SenderList, SenderListName, SendersTab } from "./types.ts"

const META: Record<SenderListName, string> = {
  allow: "Mail from these skips the spam check and always reaches the Inbox.",
  block: "Mail from these goes straight to Spam. Nothing bounces, so the sender isn’t told.",
}
const EMPTY: Record<SenderListName, string> = {
  allow: "Nobody on the allow list. “Not spam” adds people here, or add an address or a whole domain below.",
  block:
    "Nobody on the block list. “Mark as spam” and “Block sender” add people here, or add an address or domain below.",
}

const IMAGES_META =
  "Remote images from these load without asking. Images from anyone else stay blocked until you choose."
const IMAGES_EMPTY =
  "No senders yet. “Always show from …” on a message adds its sender's domain here, or add an address or domain below."

export function SendersPanel({
  list: tab,
  onList,
  titleLink = true,
  withImages = false,
}: {
  list: SendersTab
  onList: (l: SendersTab) => void
  titleLink?: boolean
  /** Show the "Images" tab (the Senders page; the panel on Rules keeps to the filing lists). */
  withImages?: boolean
}) {
  const showImages = withImages && tab === "images"
  const list: SenderListName = tab === "images" ? "allow" : tab
  const { mailboxId, access } = useMail()
  const qc = useQueryClient()
  const key = pageKeys.senders(mailboxId)
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/senders", { params: { path: { id: mailboxId } } }),
      ) as Promise<SenderList>,
  })
  const [value, setValue] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const add = useMutation({
    mutationFn: (v: string) =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/senders", {
          params: { path: { id: mailboxId } },
          body: { value: v, list },
        }),
      ) as Promise<Sender>,
    onSuccess: (s) => {
      qc.setQueryData<SenderList>(key, (old) => ({
        senders: [s, ...(old?.senders ?? []).filter((x) => x.value !== s.value)],
      }))
      setValue("")
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "Mailyard couldn’t be reached."),
  })
  const remove = useMutation({
    mutationFn: (v: string) =>
      unwrap(
        api.DELETE("/v1/mailboxes/{id}/senders/{value}", { params: { path: { id: mailboxId, value: v } } }),
      ),
    onMutate: (v) => {
      const before = qc.getQueryData<SenderList>(key)
      qc.setQueryData<SenderList>(key, (old) => ({
        senders: (old?.senders ?? []).filter((x) => x.value !== v),
      }))
      return { before }
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before)
      setProblem(e instanceof ApiError ? e.message : "Mailyard couldn’t be reached.")
    },
  })
  const all = q.data?.senders ?? []
  const shown = all.filter((s) => s.list === list)
  const count = (l: SenderListName) => all.filter((s) => s.list === l).length
  const submit = () => {
    setProblem(null)
    const v = senderValue(value)
    if (!v) return setProblem("Enter an address like name@example.com, or a domain like example.com.")
    add.mutate(v)
  }
  const verb = list === "allow" ? "Allow" : "Block"
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/mailboxes/{id}/senders?list=${list} · POST · DELETE /senders/{value}`}
    >
      <header className="panel-head">
        <h2 className="panel-title">
          {titleLink ? (
            <Link to="/mail/$mailboxId/senders" params={{ mailboxId }} search={{ list }}>
              Senders
            </Link>
          ) : (
            "Senders"
          )}
        </h2>
        <span className="panel-meta">{showImages ? IMAGES_META : META[list]}</span>
      </header>
      <div className="drawer-tabs page-tabs" role="tablist" aria-label="Sender lists">
        {(["allow", "block"] as const).map((l) => (
          <button
            key={l}
            className="tab"
            role="tab"
            type="button"
            aria-selected={!showImages && list === l}
            onClick={() => onList(l)}
          >
            {l === "allow" ? "Allowed" : "Blocked"}
            {q.data ? ` · ${count(l)}` : ""}
          </button>
        ))}
        {withImages ? (
          <button
            className="tab"
            role="tab"
            type="button"
            aria-selected={showImages}
            onClick={() => onList("images")}
          >
            Images
          </button>
        ) : null}
      </div>
      {showImages ? (
        <ImageSendersBody />
      ) : (
        <div className="panel-body stack stack-12" role="tabpanel">
          {q.isPending ? (
            <PanelSkeleton rows={3} />
          ) : q.isError ? (
            <PanelError error={q.error} onRetry={() => q.refetch()} what="The sender lists didn’t load" />
          ) : (
            <ul className="list">
              {shown.length === 0 ? (
                <li>
                  <div className="empty" style={{ padding: 16 }}>
                    <p>{EMPTY[list]}</p>
                  </div>
                </li>
              ) : (
                shown.map((s) => (
                  <li key={s.value} className="sender-row">
                    <span className="mono">{s.value}</span>
                    <span className="src">
                      {SOURCE_WORDS[s.source] ?? s.source}
                      {s.createdAt !== undefined ? ` · ${relativeShort(Number(s.createdAt))}` : ""}
                    </span>
                    <Gated
                      allowed={access.manage}
                      reason={access.manageReason}
                      who={access.manageWho}
                      side="right"
                    >
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label={`Remove ${s.value}`}
                        title={`Remove ${s.value}`}
                        onClick={() => remove.mutate(s.value)}
                      >
                        <Icon name="x" />
                      </button>
                    </Gated>
                  </li>
                ))
              )}
            </ul>
          )}
          <form
            className="cluster"
            style={{ flexWrap: "nowrap" }}
            onSubmit={(e) => {
              e.preventDefault()
              if (access.manage) submit()
            }}
          >
            <input
              className="input mono"
              placeholder="name@example.com or example.com"
              aria-label="Address or domain"
              style={{ flex: 1, minWidth: 0 }}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              {...(problem ? { "aria-invalid": true } : {})}
            />
            <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho} side="right">
              <button className="btn btn-secondary" type="submit" disabled={add.isPending}>
                {verb}
              </button>
            </Gated>
          </form>
          {problem ? (
            <p className="field-error" role="alert">
              <Icon name="warn" />
              {problem}
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}

/** The "Images" tab: senders whose remote images always load in this mailbox. Changing it needs mail write access. */
function ImageSendersBody() {
  const { mailboxId, access } = useMail()
  const qc = useQueryClient()
  const key = pageKeys.imageSenders(mailboxId)
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/image-senders", { params: { path: { id: mailboxId } } }),
      ) as Promise<ImageSenderList>,
  })
  const [value, setValue] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const add = useMutation({
    mutationFn: (v: string) =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/image-senders", {
          params: { path: { id: mailboxId } },
          body: { value: v },
        }),
      ) as Promise<ImageSender>,
    onSuccess: (s) => {
      qc.setQueryData<ImageSenderList>(key, (old) => ({
        senders: [s, ...(old?.senders ?? []).filter((x) => x.value !== s.value)],
      }))
      setValue("")
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "Mailyard couldn’t be reached."),
  })
  const remove = useMutation({
    mutationFn: (v: string) =>
      unwrap(
        api.DELETE("/v1/mailboxes/{id}/image-senders/{value}", {
          params: { path: { id: mailboxId, value: v } },
        }),
      ),
    onMutate: (v) => {
      const before = qc.getQueryData<ImageSenderList>(key)
      qc.setQueryData<ImageSenderList>(key, (old) => ({
        senders: (old?.senders ?? []).filter((x) => x.value !== v),
      }))
      return { before }
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before)
      setProblem(e instanceof ApiError ? e.message : "Mailyard couldn’t be reached.")
    },
  })
  const submit = () => {
    setProblem(null)
    const v = imageSenderValue(value)
    if (!v) return setProblem("Enter an address like name@example.com, or a domain like example.com.")
    add.mutate(v)
  }
  const shown = q.data?.senders ?? []
  return (
    <div
      className="panel-body stack stack-12"
      role="tabpanel"
      data-endpoint="GET /v1/mailboxes/{id}/image-senders · POST · DELETE /image-senders/{value} (built, HAL-3369)"
    >
      {q.isPending ? (
        <PanelSkeleton rows={3} />
      ) : q.isError ? (
        <PanelError error={q.error} onRetry={() => q.refetch()} what="The image senders didn’t load" />
      ) : (
        <ul className="list">
          {shown.length === 0 ? (
            <li>
              <div className="empty" style={{ padding: 16 }}>
                <p>{IMAGES_EMPTY}</p>
              </div>
            </li>
          ) : (
            shown.map((s) => (
              <li key={s.value} className="sender-row">
                <span className="mono">{s.value}</span>
                <span className="src">
                  {s.createdBy ? `Added by ${s.createdBy}` : "Added"}
                  {s.createdAt !== undefined ? ` · ${relativeShort(Number(s.createdAt))}` : ""}
                </span>
                <Gated allowed={access.write} reason={access.writeReason} who={access.writeWho} side="right">
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`Remove ${s.value}`}
                    title={`Remove ${s.value}`}
                    onClick={() => remove.mutate(s.value)}
                  >
                    <Icon name="x" />
                  </button>
                </Gated>
              </li>
            ))
          )}
        </ul>
      )}
      <form
        className="cluster"
        style={{ flexWrap: "nowrap" }}
        onSubmit={(e) => {
          e.preventDefault()
          if (access.write) submit()
        }}
      >
        <input
          className="input mono"
          placeholder="name@example.com or example.com"
          aria-label="Address or domain whose images always show"
          style={{ flex: 1, minWidth: 0 }}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          {...(problem ? { "aria-invalid": true } : {})}
        />
        <Gated allowed={access.write} reason={access.writeReason} who={access.writeWho} side="right">
          <button className="btn btn-secondary" type="submit" disabled={add.isPending}>
            Always show
          </button>
        </Gated>
      </form>
      {problem ? (
        <p className="field-error" role="alert">
          <Icon name="warn" />
          {problem}
        </p>
      ) : null}
    </div>
  )
}

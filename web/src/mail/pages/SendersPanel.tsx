/**
 * The allow and block lists (senders.html, and the Senders panel on rules.html): who skips the spam check
 * and who goes straight to Spam. GET/POST …/senders, DELETE …/senders/{value}.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { useMail } from "../context.tsx"
import { relativeShort, SOURCE_WORDS, senderValue } from "./logic.ts"
import { pageKeys } from "./shared.tsx"
import type { Sender, SenderList, SenderListName } from "./types.ts"

const META: Record<SenderListName, string> = {
  allow: "Mail from these skips the spam check and always reaches the Inbox.",
  block: "Mail from these goes straight to Spam. Nothing bounces, so the sender isn’t told.",
}
const EMPTY: Record<SenderListName, string> = {
  allow: "Nobody on the allow list. “Not spam” adds people here, or add an address or a whole domain below.",
  block:
    "Nobody on the block list. “Mark as spam” and “Block sender” add people here, or add an address or domain below.",
}

export function SendersPanel({
  list,
  onList,
  titleLink = true,
}: {
  list: SenderListName
  onList: (l: SenderListName) => void
  titleLink?: boolean
}) {
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
        <span className="panel-meta">{META[list]}</span>
      </header>
      <div className="drawer-tabs page-tabs" role="tablist" aria-label="Sender lists">
        {(["allow", "block"] as const).map((l) => (
          <button
            key={l}
            className="tab"
            role="tab"
            type="button"
            aria-selected={list === l}
            onClick={() => onList(l)}
          >
            {l === "allow" ? "Allowed" : "Blocked"}
            {q.data ? ` · ${count(l)}` : ""}
          </button>
        ))}
      </div>
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
    </section>
  )
}

/**
 * The auth layout (design: .auth, .auth-main, .auth-card, .auth-art): the card on the left, the paper-plane
 * art on the right. The footer shows which Mailyard this is and whether it answers (GET /healthz).
 */
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { Icon } from "./icons.tsx"
import { Wordmark } from "./Wordmark.tsx"

export function AuthLayout({ children, caption }: { children: ReactNode; caption?: string }) {
  const host = typeof window === "undefined" ? "" : window.location.host
  const health = useQuery({
    queryKey: ["healthz"],
    queryFn: async () => (await fetch("/healthz", { credentials: "omit" })).ok,
    enabled: !fixturesEnabled(),
    refetchInterval: 30_000,
    retry: false,
  })
  const up = fixturesEnabled() || health.data === true
  return (
    <div className="auth">
      <main className="auth-main" id="main">
        <div className="auth-top">
          <Wordmark />
          <a className="fy-byline" href="https://flareyard.dev">
            <img src="/ui/brand/flareyard-mark.svg" alt="" width={14} height={14} />A Flareyard app
          </a>
        </div>
        <div className="auth-center">
          <div className="auth-card">
            <div className="auth-strip">
              <Icon name="envelope" />
              <span>Email on your own Cloudflare account, from Flareyard.</span>
            </div>
            {children}
          </div>
        </div>
        <div className="auth-foot">
          <span className="cluster">
            <span
              className={`auth-host${health.isError || health.data === false ? " is-down" : ""}`}
              data-endpoint="GET /healthz"
              title={up ? "Answering" : "Not answering"}
            >
              <span className="dot" />
              {host}
            </span>
            {fixturesEnabled() ? (
              <span className="pill pill-sample sample-marker">
                <Icon name="info" />
                Sample data<span className="sr-only">: fixture mode, nothing here is real.</span>
              </span>
            ) : null}
          </span>
          <span className="cluster cluster-16">
            <a className="link-quiet" href="https://github.com/flareyard/mailyard">
              Open source
            </a>
            <a className="link-quiet" href="https://flareyard.dev/docs/mailyard">
              Docs
            </a>
          </span>
        </div>
      </main>
      <aside className="auth-art" aria-hidden="true">
        <svg className="postmark" viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <path id="pm-ring" d="M60,60 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0" />
          </defs>
          <circle cx="60" cy="60" r="56" />
          <circle cx="60" cy="60" r="34" />
          <text>
            <textPath href="#pm-ring" startOffset="0">
              your domain · your account · your yard ·
            </textPath>
          </text>
          <text className="pm-center" x="60" y="65" textAnchor="middle">
            sent
          </text>
        </svg>
        <h2>
          One letter.
          <br />
          Your own
          <br />
          domain.
          <br />
          <span>Delivered.</span>
        </h2>
        <svg className="letter" viewBox="0 0 440 320" aria-hidden="true">
          <ellipse className="l-shadow" cx="210" cy="292" rx="150" ry="10" />
          <polygon className="l-paper" points="16,148 424,22 186,196" />
          <line className="l-line" x1="96" y1="138" x2="292" y2="78" />
          <line className="l-line" x1="126" y1="152" x2="318" y2="93" />
          <line className="l-line" x1="156" y1="166" x2="262" y2="133" />
          <polygon className="l-fold" points="186,196 424,22 214,262" />
          <polygon className="l-fold-2" points="186,196 214,262 168,224" />
        </svg>
        <div className="art-cap">
          <span>{caption ?? "Every email starts from your own Cloudflare account."}</span>
          <span className="mono">{host}</span>
        </div>
      </aside>
    </div>
  )
}

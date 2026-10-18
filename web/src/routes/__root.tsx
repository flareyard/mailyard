import type { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router"
import { Wordmark } from "../ui/Wordmark.tsx"

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <main className="auth-page" id="main">
      <div className="auth-card">
        <Wordmark />
        <h1 className="t-h1">Nothing lives here</h1>
        <p className="muted">
          That address isn’t a page in Mailyard. It may have moved, or the link was cut short.
        </p>
        <Link className="btn btn-primary" to="/">
          Go to the Overview
        </Link>
      </div>
    </main>
  )
}

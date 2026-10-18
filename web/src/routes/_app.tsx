/**
 * Everything behind sign-in. `beforeLoad` resolves /v1/me (cached); a 401 sends you to /sign-in with where you
 * were going, so signing in lands you back there.
 */
import { createFileRoute, Outlet, redirect, useMatches } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { ApiError } from "../api/client.ts"
import { ReauthSheet } from "../auth/ReauthSheet.tsx"
import { meQuery } from "../auth/session.ts"
import { AppFrame } from "../shell/AppFrame.tsx"
import { PageTitleContext } from "../shell/title.tsx"

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        throw redirect({
          to: "/sign-in",
          search: {
            next: location.href,
            ...(e.reason === "session-expired" ? { error: "session-expired" } : {}),
          },
        })
      }
      throw e
    }
  },
  component: AppLayout,
})

function AppLayout() {
  const matches = useMatches()
  const fromRoute = [...matches].reverse().find((m) => m.staticData?.title)?.staticData?.title
  const [override, setOverride] = useState<string | null>(null)
  const title = override ?? fromRoute
  useEffect(() => {
    document.title = title ? `${title} · Mailyard` : "Mailyard"
  }, [title])
  return (
    <PageTitleContext.Provider value={setOverride}>
      <AppFrame {...(title ? { title } : {})}>
        <Outlet />
      </AppFrame>
      <ReauthSheet />
    </PageTitleContext.Provider>
  )
}

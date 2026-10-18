import { createFileRoute, Link } from "@tanstack/react-router"
import { AuthLayout } from "../ui/AuthLayout.tsx"
import { Icon } from "../ui/icons.tsx"

export const Route = createFileRoute("/signed-out")({ component: SignedOut })

function SignedOut() {
  return (
    <AuthLayout>
      <div>
        <h1>You’re signed out</h1>
        <p className="lede">
          The session cookie on this browser is gone. Your key still works everywhere else.
        </p>
      </div>
      <div className="callout callout-info">
        <Icon name="shield" />
        <span>
          Signing out ends only this browser’s session. Revoke a key in Settings → API keys to stop it
          everywhere.
        </span>
      </div>
      <Link className="btn btn-primary btn-lg btn-block" to="/sign-in">
        Sign in again
      </Link>
    </AuthLayout>
  )
}

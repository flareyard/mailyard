import { createFileRoute } from "@tanstack/react-router"
import { type ApprovalStatus, Approvals } from "../../../settings/integrations/Approvals.tsx"

export type ApprovalsSearch = { status?: Exclude<ApprovalStatus, "pending">; reject?: string }

export const Route = createFileRoute("/_app/settings/integrations/approvals")({
  staticData: { title: "Approval queue" },
  validateSearch: (s: Record<string, unknown>): ApprovalsSearch => ({
    ...(s.status === "approved" || s.status === "rejected" || s.status === "failed"
      ? { status: s.status }
      : {}),
    ...(typeof s.reject === "string" && s.reject ? { reject: s.reject } : {}),
  }),
  component: Approvals,
})

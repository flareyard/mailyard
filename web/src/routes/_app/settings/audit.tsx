import { createFileRoute } from "@tanstack/react-router"
import { AuditPage } from "../../../settings/audit/AuditPage.tsx"
import { type AuditSearch, validateAudit } from "../../../settings/audit/logic.ts"

export const Route = createFileRoute("/_app/settings/audit")({
  staticData: { title: "Audit log" },
  validateSearch: (s: Record<string, unknown>): AuditSearch => validateAudit(s),
  component: AuditPage,
})

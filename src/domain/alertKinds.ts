/**
 * Every alert Mailyard raises (HAL-3364), one name each. Each is raised by the event that causes it or
 * by the hourly sweep (src/domain/alertSweep.ts), and cleared when its condition clears; the notices
 * (`export_ready`, `domain_activated`, `import_failed`) clear themselves after a while.
 */
export const ALERT_KINDS = [
  "delivery_events_missing",
  "campaign_paused",
  "dns_drift",
  "reputation_warning",
  "reputation_at_risk",
  "bounce_spike",
  "complaint_spike",
  "quota_80",
  "quota_100",
  "webhook_dead_letter",
  "import_failed",
  "export_ready",
  "domain_activated",
  "automation_failed",
  "approval_pending",
] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

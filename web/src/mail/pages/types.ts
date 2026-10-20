/** Types for the mailbox pages (rules, senders, import, export, labels, smart folders), from the schema. */
import type { paths } from "../../api/schema"

type Json<
  P extends keyof paths,
  M extends "get" | "post" | "patch" | "put" | "delete",
  S extends number = 200,
> = paths[P][M] extends { responses: { [K in S]: { content: { "application/json": infer R } } } } ? R : never

type Body<P extends keyof paths, M extends "post" | "patch" | "put"> = paths[P][M] extends {
  requestBody?: { content: { "application/json": infer B } }
}
  ? B
  : never

export type RuleList = Json<"/v1/mailboxes/{id}/rules", "get">
export type Rule = RuleList["rules"][number]
export type RuleCondition = Rule["conditions"][number]
export type RuleAction = Rule["actions"][number]
export type RuleCreate = Body<"/v1/mailboxes/{id}/rules", "post">
export type RuleTest = Json<"/v1/mailboxes/{id}/rules/test", "post">
export type RuleApply = Json<"/v1/mailboxes/{id}/rules/{ruleId}/apply", "post">
export type ApplyFolder = NonNullable<Body<"/v1/mailboxes/{id}/rules/{ruleId}/apply", "post">["folder"]>

export type SenderList = Json<"/v1/mailboxes/{id}/senders", "get">
export type Sender = SenderList["senders"][number]
export type SenderListName = Sender["list"]

export type ImportList = Json<"/v1/mailboxes/{id}/imports", "get">
export type MailImport = ImportList["imports"][number]
export type ImportFolder = MailImport["folders"][number]
export type Probe = Json<"/v1/mailboxes/{id}/imports/probe", "post">
export type ProbeFolder = Probe["folders"][number]

export type ExportList = Json<"/v1/mailboxes/{id}/exports", "get">
export type MailExport = ExportList["exports"][number]

export type LabelBody = Json<"/v1/mailboxes/{id}/labels/{labelId}", "patch">
export type SmartFolderList = Json<"/v1/mailboxes/{id}/smart-folders", "get">
export type SmartFolder = SmartFolderList["smartFolders"][number]

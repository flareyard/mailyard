---
name: add-inbox-rule-action
description: Add a new action to Mailyard's inbox rules (what a matching rule does to incoming mail, beside label, archive, forward, auto-reply, webhook and assign), for example "set priority", "snooze" or "notify". Use when a mailbox rule needs to do something the existing actions can't.
---

# Add an inbox rule action

A mailbox rule is conditions plus actions (`src/rules/engine.ts`). Incoming mail runs through four stages, and a new action touches each one it takes part in:

1. **Decide** (`evaluate` in `engine.ts`): pure. It merges every matching rule's actions into one `RuleOutcome`.
2. **Plan** (`planFiling` in `src/rules/filing.ts`): folds the outcome together with the mailbox's sender lists and the spam score into a `FilingPlan`: how the message is stored, and the `effects` to run after.
3. **Store** (`MailboxStore`, `src/mailbox/store.ts`, inside the mailbox Durable Object): applies the plan's filing fields in one transaction.
4. **Effects** (`runEffects` in `src/rules/effects.ts`): what reaches outside (forwards, auto-replies, webhooks). Runs only for a newly stored copy, so a retried delivery never repeats it. Spam gets no effects.

Decide which kind your action is first: a **filing** action changes the stored message or conversation (like `star`, `assign`), an **effect** action does something outside (like `forward`, `webhook`).

## Steps

1. **Declare it** in the `Action` union in `engine.ts`, with schema checks for its fields (lengths, counts, patterns). Type names are camelCase.
2. **Decide**: add its field to `RuleOutcome` with a doc comment saying how several matching rules combine (last wins, like `assignee`; or they add up, like `labelIds`), handle it in `evaluate`'s `switch`, and return it. The `switch` has no default, so the typecheck points at every place that has to handle the new type.
3. **Validate the references** in `src/rules/manage.ts` (beside the endpoint and assignee checks): anything the action names (a label, a key, an endpoint, an address) must exist when the rule is saved. Refuse with `RuleInvalid({ field: "actions", message })`, a sentence the user can act on.
4. **Plan**: carry it into the `FilingPlan` in `filing.ts`, as a filing field or an entry in `effects`. Decide what spam does with it (effects are dropped for spam; a filing field usually is too, like `assignee: isSpam ? null : …`).
5. **Carry it out**:
   - Filing action: add the field to the filing input in `src/mailbox/types.ts` and apply it in `MailboxStore` where the other filing fields are applied, in the same transaction. If it needs new mailbox columns, append a migration to `src/mailbox/schema.ts` (never edit a shipped one).
   - Effect action: a branch in `runEffects`, wrapped in `attempt(...)` so one failing is logged and never undoes the filing or stops the others.
6. **Apply to existing mail** (`MailboxStore.applyRule`, `POST …/rules/{ruleId}/apply`): add a filing action there too. Leave effect actions out: applying a rule never sends anything, and the doc comment there says so.
7. **The test endpoint** (`POST …/rules/test`) returns the outcome typed in `src/http/Api.ts`; add the new field to that schema.
8. **Test it** in `test/rules/`:
   - `engine.test.ts` ("merges actions in order…"): how the action combines across matching rules, with no runtime needed.
   - `inbox.test.ts`: deliver a message through the real pipeline and assert the stored result (copy "labels, archives and marks read what matches"), or for an effect, that it ran once even when filing is retried (copy "runs rule forwards and rule webhooks, once"). Add a refusal to "refuses rules that can't work", and for a filing action, a case to "applies a rule to mail already there".
9. **Update the contract.** Run `bunx vitest run test/health.test.ts -u`, read the OpenAPI snapshot diff (only the new action and outcome field should appear), and say in the PR that it's a contract change. Then `bun run check`.
   Done when `bun run check` passes and the snapshot diff shows only the new action.

## Reference

- Matching is literal (no regex), so a rule can't hang the pipeline; keep any matching inside a new action literal too.
- An action that sends mail follows `sendAutoReply` and `sendForward` in `effects.ts`: RFC 3834 guards, loop headers, and sending through `sendFromMailbox`.

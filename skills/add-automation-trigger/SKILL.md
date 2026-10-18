---
name: add-automation-trigger
description: Add a new way for Mailyard automations to start (a trigger kind beside event, created, topic, segment, date and mail_received), for example "a form was submitted" or "a payment failed". Use when an automation should begin on something no existing trigger catches.
---

# Add an automation trigger

A trigger is the first node of an automation's graph (`TriggerConfig` in `src/automations/graph.ts`). Something in the app fires it; the automation queue's consumer (`handleTrigger` in `src/automations/runs.ts`) finds the live automations listening and enters the contact into each, through `enterAutomation`. `mail_received` (HAL-3467) is the newest whole example: read it first.

## Steps

1. **Declare the kind** in `TriggerConfig` (`src/automations/graph.ts`): a `Schema.Struct({ kind: Schema.Literal("<snake_case>"), … })` with the filters it takes, every limit the schema can express (`isMaxLength`, `isMinLength`). A bad graph is then refused at the API edge.
2. **Give it a lookup key.** `triggerKeyOf` (`src/automations/automations.ts`) turns a trigger into what's stored on the automation for lookup: `<kind>` alone, or `<kind>:<id>` when automations listen for one thing (one event name, one topic). The firing side must build the same key (`triggerKeyFor` in `runs.ts`). Filters that vary per automation (mailboxes, domains, subjects) don't go in the key: they're checked on entry (step 5).
3. **Say what a run carries.** Add the kind to `TRIGGER_DATA_KEYS` (`src/automations/triggerData.ts`): the `trigger.<key>` placeholders its runs will have. An automation whose template needs a key the trigger doesn't carry is refused at publish. Then add the kind to `entryTriggerData` (`src/automations/entryData.ts`): what's stored on the run, from the data the firing passed.
4. **Fire it.** Add the kind to `AutomationTriggerJob` in `runs.ts`, then call `fireTrigger({ kind, contactId, key?, data })` from the code where the thing happens. Rules:
   - Fire only after the thing is durable (stored, committed), and only once: a retry of the same work must not fire twice.
   - Never fail the caller: wrap it (`Effect.catchCause` to a log), as `fireMailReceived` does.
   - Don't create or change contacts unless a live automation listens; check first, as `fireMailReceived` does, so ordinary traffic leaves the audience alone.
   - Guard against loops: something an automation itself causes (its own sends, auto-replies) must not start it again.
5. **Check filters on entry.** If the trigger has filters, check them in `enterAutomation` (`runs.ts`) against the run's data and skip with a reason (`"skipped: the mail doesn't match the trigger"`), as `mailMatches` does. Re-entry, cooldown and blocked contacts are already handled there.
6. **Test it** end to end: publish an automation with the trigger, cause the real thing (for mail, through `handleEmail`), run the automation queue's batch by hand (`createMessageBatch("mailyard-automation-triggers", …)` and `worker.queue`), and assert the run exists with the expected `triggerData`. Cover each filter, each guard (automated mail, spam, the loop case) and "nothing listening changes nothing". `test/automations/mailTrigger.test.ts` is the model.
7. **Update the contract and the web app's builder.** The graph schema is in the OpenAPI document: run `bunx vitest run test/health.test.ts -u`, check that only the new trigger appears, and say in the PR it's a contract change. Tell whoever owns `web/` the new kind and its data keys for the automation builder. Then `bun run check`.

Done when `bun run check` passes, a real occurrence starts a run in the test, and the snapshot diff shows only the new trigger.

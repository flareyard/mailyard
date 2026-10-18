---
name: add-webhook-event
description: Add a new outgoing webhook event type to Mailyard (like contact.created or mail.received), so endpoints can subscribe to it and receive signed deliveries. Use when something that happens in Mailyard should notify the user's own systems.
---

# Add a webhook event

Webhook endpoints subscribe to event types; Mailyard records one delivery per subscribed endpoint and a queue consumer posts it, signed per Standard Webhooks, retrying up to 8 times (`src/domain/webhooks.ts`). Adding an event is a name in one list and one `emitSafely` call where the thing happens.

## Steps

1. **Name it** `<noun>.<past-tense verb>` (`contact.suppressed`, `mail.rule_matched`), and add it to `WEBHOOK_EVENTS` in `src/domain/webhooks.ts`, beside its family. The API's `WebhookEventSchema` and the event list `GET /v1/webhooks` returns derive from that list, so nothing else needs the name.
2. **Emit it** where the change is committed, right after the write: `yield* emitSafely("<event>", { … })`. `emitSafely` records deliveries and never fails the caller; a webhook outage must not undo the user's action.
   - Emit once per change: on the path that actually made the change, not on a retry or a no-op (an update that changed nothing emits nothing).
   - The payload: ids first (`contactId`, `mailboxId`, …), then the few fields a receiver acts on, in camelCase. Match the shape of the event's siblings (`contact.*` payloads all carry `email`). Leave out secrets and message bodies.
   - Pass `onlyEndpointId` as the third argument only when one endpoint asked for it (a rule's webhook action does this).
3. **Test it.** Turn the change on through the API in the test for that area, with an endpoint subscribed to the event, and read the delivery row, the way `test/rules/inbox.test.ts` checks `mail.rule_matched`:
   ```ts
   const row = await env.DB.prepare(
     "select payload from webhook_deliveries where endpoint_id = ? and event_type = '<event>'",
   ).bind(endpointId).first<{ payload: string }>()
   ```
   Create the endpoint with `call("/v1/webhooks", { method: "POST", key: ADMIN, json: { url: "https://hooks.test/x", events: ["<event>"] } })`. Assert the payload's fields, and that a repeat or no-op adds no second row. Signing, retries and replay are already covered in `test/webhooks/webhooks.test.ts`; don't repeat them.
4. **Update the contract.** The event list is in the OpenAPI document. Run `bunx vitest run test/health.test.ts -u`, read the snapshot diff (only the new name should appear), and say in the PR that it's a contract change. Then `bun run check`.
   Done when `bun run check` passes and the snapshot diff shows only the new event.

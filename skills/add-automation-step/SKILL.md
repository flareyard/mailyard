---
name: add-automation-step
description: Add a new step type to Mailyard's automations (a node in the graph, like send, wait, branch or webhook), for example "notify Slack", "add a tag" or "call an API". Use when an automation needs to do something no existing step does.
---

# Add an automation step

An automation is a graph of nodes (`src/automations/graph.ts`). Every node type has one **step definition** in `src/automations/steps/`: `validate` checks its settings, `run` does the work through a `StepContext` and says where the run goes next. The real run (the Workflow, through `src/automations/runs.ts`) and the dry run (`src/automations/dryRun.ts`) both call the same `runStep`, so a step written once behaves the same in both.

## Steps

1. **Pick the nearest step to copy.** `webhook.ts` (calls out over HTTP), `update.ts` (changes the contact), `topic.ts`, `send.ts`, `branch.ts` (two ways out), `wait.ts` (sleeps). Read it and `steps/types.ts`, the `StepContext`.
2. **Declare the node** in `src/automations/graph.ts`: `export const SlackNotifyNode = node("slack_notify", Schema.Struct({ … }))`, beside the others, and add it to the `GraphNode` union. Type names are snake_case. Put every check the schema can express in the schema (`Schema.isPattern(/^https:\/\//)` for URLs, `isMinLength`, `isMaxLength`); a bad graph is then refused with a 400 at the API edge.
   - A step with more than one way out also needs its ports in `portsOf` (and `Port` if the names are new). Most steps have one.
3. **Write the step** in `src/automations/steps/<camelName>.ts`, exporting a `StepDefinition<"<type>">`:
   - `validate(node)`: what the schema can't check, as a sentence the editor shows the user, or `null`. For a text setting with placeholders, check its sections close: `placeholdersOf(text)` from `src/domain/render.ts` throws `TemplateSyntaxError` with the line.
   - `run(node, ctx)`: do the work only through `ctx`. Return `{ kind: "next", detail }` with a past-tense `detail` the run history shows ("Posted to #sales."). Throw an `Error` to fail the step: the Workflow retries it (4 times, backing off from 30 s) and then marks the run failed. Returning `next` instead carries on as if it worked, so return it only when the step's job is genuinely optional.
   - Placeholders in text settings: fill them with `render(text, vars, { escape: false })` from `src/domain/render.ts`, with `vars` from `ctx.contact` (`name`, `email`, and the custom fields at the top level), the way a template sees them.
   - Contact data is untrusted: anyone can sign up as `<!channel>`. Escape each contact value for the destination's markup before filling it in (for Slack mrkdwn, `&`, `<` and `>`), and leave the author's own text alone so their formatting works.
4. **Register it** in `src/automations/steps/index.ts`: import it and add it to `STEPS` under its type. `STEPS` is typed over every node type, so `bun run typecheck` fails until it's there.
5. **Give it what it needs from the outside.** When `StepContext` already has the capability (`webhook`, `send`, `updateFields`, `setTopic`), use it. When it doesn't (a plain HTTP POST that isn't a signed Mailyard webhook, for instance), add one method to `StepContext` in `steps/types.ts` and implement it in both places, or the typecheck fails:
   - `src/automations/runs.ts`, in the context the run builds (beside `webhook:`): the real call, wrapped in `run$(Effect…)` like its neighbours. Time-box outbound calls (`AbortSignal.timeout`) and keep secrets out of the run's step log.
   - `src/automations/dryRun.ts` (beside `webhook: async () => ({ status: 200 })`): a stand-in that answers success and never calls out. A dry run must never touch the outside world; what the user sees of the step there is its `detail`.
   - The test context, `test/automations/stepContext.ts`: a `record(...)` entry, so step tests can assert the call.
6. **Test it.** Add an `it` per behaviour to `test/automations/steps.test.ts`, copying the webhook case: decode a node with `GraphNode`, check `validateStep`, run it with `fakeContext()` and assert the outcome and the recorded `calls`, and cover the failure path with an override (`fakeContext({ webhook: async () => ({ status: 500 }) })`). Add a case to `test/automations/model.test.ts` ("checks graphs and settings at the edge") when the schema refuses something, and one to `test/automations/dryRun.test.ts` showing a dry run never calls out (a step that carries on is reported there as `outcome: "would-run"`). Run `bunx vitest run --project worker test/automations/steps.test.ts`.
7. **Update the contract.** A new node type changes the OpenAPI document. Run `bunx vitest run test/health.test.ts -u`, read the snapshot diff (only your node should appear, once per place the graph schema is used; `isPattern` checks don't show in it but are still enforced), and say in the PR that it's a contract change. Then `bun run check`.
   Done when `bun run check` passes and the snapshot diff shows only the new node.

## Reference

- A step that only reads (a check) is a `branch` condition, not a new step: see `branch.ts` and the segment `Rule` it evaluates.
- Settings every step can read: `ctx.settings` (sender, topic, cadence, quiet hours); `ctx.now` is simulated time in a dry run, so use it rather than `Date.now()`.
- Secrets a step needs (a Slack webhook URL is one) live in the node's config or in a Worker secret read in `runs.ts`. A config field that holds one goes in `SECRET_FIELDS` (`src/automations/secrets.ts`): keys without `admin` then read it redacted (`https://host/•••`), and saving a graph that still holds the redacted value keeps the stored one. Keep secrets out of `detail` too.

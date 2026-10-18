---
name: add-template
description: Add an email template to Mailyard's template library (src/templates/library), so it ships with the repo, is proven by `bun run check`, and installs into a running Mailyard. Use when asked for a new email (birthday, receipt, reminder, digest) or to change a shipped one.
---

# Add a template

A template in a running Mailyard is data (D1, versioned, edited in the UI). The **library** is the code copy that ships with the repo: one file per template, rendered by a test on every `bun run check`, and put into a Mailyard by `bun run templates:install`. Edit the library, never the generated HTML.

## Steps

1. **Copy the closest template.** `src/templates/library/welcome.ts` (automation mail, reads `trigger.*`) or `receipt.ts` (sent from your own code with `POST /v1/send`, reads `data.*`). Name the file by its slug, kebab-case: `birthday` lives in `birthday.ts` and exports `birthday`.
   Done when the new file exports a `LibraryTemplate` whose `slug` matches its file name and whose `name` is unique.
2. **Write the content.** Prefer `kind: "blocks"`: a `BlocksDocument` (`src/templates/document.ts` lists every block: heading, paragraph, button, steps, stats, list, receipt, otp, progress, feedback, question, file, html). The kit lays it out in the sender's brand and writes the text part. Use `kind: "html"` only for a design the blocks can't express.
   - Placeholders: `{{ name }}`, `{{ trigger.plan }}`, `{{ name ?? "there" }}`, and `{{#if x}}…{{/if}}`, `{{#each items}}…{{/each}}` (`src/domain/render.ts`). No expressions or helpers.
   - What a send passes: the contact's custom fields at the top level, `name`, `email`, `unsubscribe_url`, `preferences_url`, `topic`; plus `trigger` (the tracked event's data) and `automation.name` in automations, `data` (the request's data) from `POST /v1/send`, `campaign.name` in campaigns.
   - Every required placeholder (outside a section, with no `??` fallback) must have a value at send time. Give optional ones a fallback.
   - Put `{{ unsubscribe_url }}` in the footer links for marketing or automation mail; without it Mailyard appends its own footer.
3. **Fill `sample`** with what a real send would pass, nested the same way (`trigger: { … }` or `data: { … }`).
   Done when every placeholder the template uses has a sample value.
4. **Register it** in `src/templates/library/index.ts`: import it and add it to `LIBRARY`.
5. **Prove it.** Run `bunx vitest run --project unit test/templates/library.test.ts`, then `bun run check`. The library test checks the file is listed under its slug, the template is valid, every required placeholder has a sample, and the sample renders with nothing left as `{{`. Add your own `it` to that file only for behaviour specific to your template (a section that hides when empty, say).
   Done when `bun run check` passes.
6. **Install it** (when asked to put it into a running Mailyard): `MAILYARD_URL=… MAILYARD_KEY=… bun run templates:install --dry-run <slug>` to see what it would do, then the same without `--dry-run`. It creates the template, or adds a draft version to the one with the same name. Add `--publish` only when the user asked for it to be live: automations and `POST /v1/send` use the published version. The key needs the `admin` scope.

## Using it

- In an automation: a `send` node with `config.templateId` (the installed id) and `version: "published"`.
- From code: `POST /v1/send` with `template` set to the id and `data` holding the values.
- Preview any template with `POST /v1/templates/preview` (`kind`, `subject`, `source`, `data`), or a saved one with `POST /v1/templates/{id}/render`.

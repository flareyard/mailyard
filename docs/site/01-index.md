---
summary: What Mailyard is, and where each page of these docs starts.
---

# Mailyard docs

Mailyard is email on your own Cloudflare account: mailboxes people and agents read and write, transactional sending, contacts, campaigns and automations. This Mailyard answers at `{{origin}}`.

## Start here

- [Get started](/docs/getting-started): an API key, then your first email in one request.
- [Agent mailboxes](/docs/agents): give an AI agent its own address, with limits and a person in the loop.
- [Connect an MCP client](/docs/mcp): Claude, ChatGPT or any MCP client, over OAuth or with a key.

## Guides

- [Sending email](/docs/sending): the send API, templates, tracking and idempotency.
- [Receiving email](/docs/receiving): mailboxes, routing, rules and spam.
- [Webhooks](/docs/webhooks): events, signatures and retries.
- [Errors](/docs/errors): what each refusal means and what to do next.
- [Self-deploy or Flareyard](/docs/deploying): two ways to run Mailyard, and what differs.

## Reference

- [HTTP API](/docs/api): every endpoint this Mailyard serves, from its own OpenAPI document (`{{origin}}/openapi.json`).
- [MCP tools](/docs/mcp-tools): every tool the MCP server offers, with its inputs and the scope it needs.

## For agents

These docs are also plain text: [`{{origin}}/llms.txt`]({{origin}}/llms.txt) is the index, [`{{origin}}/llms-full.txt`]({{origin}}/llms-full.txt) is every page in one file, and any page is Markdown with `.md` added, such as [`/docs/agents.md`](/docs/agents.md).

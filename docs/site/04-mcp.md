---
summary: Connect Claude, ChatGPT or any MCP client to /mcp, over OAuth or with a key, and how the tools behave.
---

# Connect an MCP client

Mailyard is an MCP server at `{{origin}}/mcp` (Streamable HTTP). Any MCP client can read mailboxes, search, draft, reply and send through it, within what its key allows. Every tool is listed in [MCP tools](/docs/mcp-tools).

## With OAuth (Claude, ChatGPT and other clients that support it)

Add a custom connector with the URL `{{origin}}/mcp`. The client discovers Mailyard's authorization server from `{{origin}}/.well-known/oauth-protected-resource/mcp`, sends you to sign in, and asks which mailboxes and scopes to grant. Mailyard then issues the client a key of its own; you can see and revoke the grant in **Settings → Integrations**.

## With a key

Clients without OAuth send a key as a bearer token:

```json
{
  "mcpServers": {
    "mailyard": {
      "url": "{{origin}}/mcp",
      "headers": { "Authorization": "Bearer sk_…" }
    }
  }
}
```

Use an [agent mailbox](/docs/agents)'s key for an agent, so its sends have limits and its actions are attributed to it.

## How the tools behave

- Start with `list_mailboxes` or `search_mail` to find a `mailboxId`.
- Drafting never sends. `send_draft` and `send_email` need `confirm: true`; show the user what will go out first.
- A key with limits may be refused (`agent_limit`, `recipient_not_allowed`) or have its send held for approval. Refusals come back as tool results with `isError`, `reason` and the details, so the model can explain or adjust; see [Errors](/docs/errors).
- `wait_for_mail` blocks until new mail arrives in a mailbox, for agents that work in a loop.
- `read_attachment` returns PDF and Office files as text.

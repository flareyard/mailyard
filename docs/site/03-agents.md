---
summary: Give an AI agent its own address on your domain, with send limits, approvals by a person, and a log of what it did.
---

# Agent mailboxes

An agent mailbox gives an AI agent its own address on your domain, such as `support-agent@acme.com`. The agent reads and writes mail through [MCP](/docs/mcp) with a key of its own, inside limits you set, and the people in your workspace can read along in **Mail**.

## Create one

In the app, open **Agents → New agent mailbox**, or call the API:

```sh
curl {{origin}}/v1/agents \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Support agent",
    "address": "support-agent@acme.com",
    "scopes": ["read", "send"],
    "limits": {
      "sendsPerDay": 50,
      "recipients": "contacts",
      "allowDomains": [],
      "requireApproval": false
    }
  }'
```

This makes three things at once: the mailbox, a key with `purpose: mcp` that belongs to the agent, and the agent record that ties them together. The key is shown once; give it to the agent's MCP client, or connect the client over [OAuth](/docs/mcp) instead and skip handling the key.

## Limits

| Limit | What it does |
|---|---|
| `sendsPerDay` | Sends counted per UTC day. Over the cap, a send is refused with `agent_limit`. `null` means no cap. |
| `recipients` | `any`, `contacts` (only addresses in your contacts) or `domains` (only `allowDomains` and their subdomains). Outside it, a send is refused with `recipient_not_allowed`. |
| `requireApproval` | Every send waits in **Agents → Approvals** until a person approves or rejects it. |

Limits apply to every way the key can send: `POST /v1/send`, the MCP tools `send_email` and `send_draft`, and test sends. Campaigns refuse limited keys.

## Approvals

A held send answers with `data.approval: { id, status: "pending" }` and an empty `emails` list instead of sending. People see it in **Agents → Approvals** (and as an `approval.pending` [webhook](/docs/webhooks)); approving sends it, rejecting it tells the agent why.

## Waking the agent

Give the agent a `wake` URL when you create it, and Mailyard POSTs `mail.received` there when new mail lands in its mailbox. An agent already connected can call the MCP tool `wait_for_mail` instead and block until something arrives.

## What it did

Each agent's page in **Agents** lists its activity, newest first: searches, reads, drafts, sends and changes. Reads are recorded as ids and queries, never the mail's content. The same entries are in **Settings → Audit log**, with the agent's key as the actor.

## Removing an agent

Removing an agent revokes its key at once and rejects its held sends. Its mailbox and mail stay.

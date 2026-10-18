import type { LibraryTemplate } from "./types.ts"

/** A payment receipt, sent from the API (`POST /v1/send`) with the order as `data`. */
export const receipt: LibraryTemplate = {
  slug: "receipt",
  name: "Receipt",
  description:
    "Sent after a payment, from your own code (`POST /v1/send` with `data`), with the order's lines and total.",
  kind: "blocks",
  subject: "Your receipt for {{ data.order }}",
  document: {
    preheader: "Thanks for your payment.",
    label: "Receipt",
    blocks: [
      { type: "heading", text: 'Thanks, {{ name ?? "there" }}' },
      { type: "paragraph", text: "We've received your payment for order {{ data.order }}." },
      {
        type: "receipt",
        lines: [{ label: "{{ data.item }}", value: "{{ data.amount }}" }],
        total: { label: "Total", value: "{{ data.amount }}" },
      },
      { type: "button", label: "View your order", url: "{{ data.url }}", style: "ghost" },
    ],
    footer: { reason: "You're getting this because you made a payment with {{ email }}." },
  },
  sample: {
    name: "Ada",
    email: "ada@example.com",
    unsubscribe_url: "https://mail.example.com/u/sample",
    data: {
      order: "A-1042",
      item: "Annual plan",
      amount: "$120.00",
      url: "https://example.com/orders/A-1042",
    },
  },
}

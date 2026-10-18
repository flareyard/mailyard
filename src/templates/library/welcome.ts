import type { LibraryTemplate } from "./types.ts"

/**
 * The first email after sign-up: three steps to get going. Sent by an automation on a tracked
 * `signed_up` event whose data carries `url`; without it the button falls back to the site.
 */
export const welcome: LibraryTemplate = {
  slug: "welcome",
  name: "Welcome",
  description: "Sent once, right after someone signs up: what to do first.",
  kind: "blocks",
  subject: 'Welcome, {{ name ?? "there" }}',
  document: {
    preheader: "Three steps to get going.",
    label: "Welcome",
    blocks: [
      { type: "heading", text: 'Welcome, {{ name ?? "there" }}' },
      { type: "paragraph", text: "Thanks for signing up. Here's how to get the most out of it." },
      {
        type: "steps",
        items: [
          { title: "Finish your profile", sub: "So we can tailor what you see." },
          { title: "Try the main feature", sub: "It takes about two minutes." },
          { title: "Tell us how it went", sub: "Reply to this email: a person reads every one." },
        ],
      },
      { type: "button", label: "Get started", url: '{{ trigger.url ?? "https://example.com" }}' },
    ],
    footer: {
      reason: "You're getting this because you signed up with {{ email }}.",
      links: [{ label: "Unsubscribe", url: "{{ unsubscribe_url }}" }],
    },
  },
  sample: {
    name: "Ada",
    email: "ada@example.com",
    unsubscribe_url: "https://mail.example.com/u/sample",
    preferences_url: "https://mail.example.com/p/sample",
    trigger: { url: "https://example.com/start" },
  },
}

import * as Schema from "effect/Schema"

/** A link in a block: http(s) URLs only, so a template can't carry `javascript:` into a message. */
const Url = Schema.String.check(Schema.isPattern(/^(https?:\/\/|\{\{)/))
const LabelUrl = Schema.Struct({ label: Schema.String, url: Url })
const LabelValue = Schema.Struct({ label: Schema.String, value: Schema.String })

/**
 * One block of a `blocks` template: a call to the kit (src/templates/kit.ts) as data. Every string can
 * hold {{ placeholders }}; values are filled in first and escaped by the kit.
 */
export const BlockSpec = Schema.Union([
  Schema.Struct({ type: Schema.Literal("heading"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("subheading"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("paragraph"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("note"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("warn"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("button"),
    label: Schema.String,
    url: Url,
    style: Schema.optionalKey(Schema.Literals(["primary", "ghost", "danger"])),
  }),
  Schema.Struct({
    type: Schema.Literal("buttons"),
    items: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        url: Url,
        style: Schema.optionalKey(Schema.Literals(["primary", "ghost", "danger"])),
      }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("stats"), items: Schema.Array(LabelValue) }),
  Schema.Struct({
    type: Schema.Literal("list"),
    items: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        sub: Schema.optionalKey(Schema.String),
        url: Schema.optionalKey(Url),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("steps"),
    items: Schema.Array(Schema.Struct({ title: Schema.String, sub: Schema.optionalKey(Schema.String) })),
  }),
  Schema.Struct({ type: Schema.Literal("meta"), items: Schema.Array(LabelValue) }),
  Schema.Struct({ type: Schema.Literal("receipt"), lines: Schema.Array(LabelValue), total: LabelValue }),
  Schema.Struct({ type: Schema.Literal("otp"), code: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("progress"),
    stages: Schema.Array(Schema.String),
    done: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("feedback"),
    label: Schema.String,
    question: Schema.String,
    answers: Schema.Array(LabelUrl),
  }),
  Schema.Struct({
    type: Schema.Literal("file"),
    tag: Schema.String,
    name: Schema.String,
    sub: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("question"),
    label: Schema.String,
    stem: Schema.String,
    answers: Schema.Array(LabelUrl),
  }),
  /** Raw HTML rows (`<tr>…</tr>`), for what the blocks don't cover. Placeholders in it are escaped. */
  Schema.Struct({
    type: Schema.Literal("html"),
    html: Schema.String,
    text: Schema.optionalKey(Schema.String),
  }),
])
export type BlockSpec = typeof BlockSpec.Type

export const BlocksDocument = Schema.Struct({
  /** The hidden inbox preview line. */
  preheader: Schema.String,
  /** Small caps label at the top right. */
  label: Schema.String,
  blocks: Schema.Array(BlockSpec),
  /** Why the recipient gets this, and links out (preferences, unsubscribe). */
  footer: Schema.Struct({ reason: Schema.String, links: Schema.optionalKey(Schema.Array(LabelUrl)) }),
})
export type BlocksDocument = typeof BlocksDocument.Type

export const decodeBlocksDocument = Schema.decodeUnknownExit(BlocksDocument)

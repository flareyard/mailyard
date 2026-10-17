import { describe, expect, it } from "vitest"
import { parseTemplate, render, TemplateSyntaxError } from "../../src/domain/render.ts"
import { validateTemplate, variablesOf } from "../../src/templates/render.ts"
import { ADMIN, call } from "../helpers.ts"

const html = (source: string, vars: Record<string, unknown>) => render(source, vars, { escape: true })
const text = (source: string, vars: Record<string, unknown>) => render(source, vars, { escape: false })

describe("template sections", () => {
  it("loops over a list, with the item's fields, its position, and an else for none", () => {
    const source =
      "<ul>{{#each courses}}<li>{{ @index }}. {{ title }}{{#if @last}}.{{else}},{{/if}}</li>{{else}}<li>Nothing yet</li>{{/each}}</ul>"
    expect(html(source, { courses: [{ title: "Rust" }, { title: "Go" }] })).toBe(
      "<ul><li>0. Rust,</li><li>1. Go.</li></ul>",
    )
    expect(html(source, { courses: [] })).toBe("<ul><li>Nothing yet</li></ul>")
    expect(html(source, {})).toBe("<ul><li>Nothing yet</li></ul>")
    // `this` for plain lists and explicit item fields; outer data still reachable inside the loop.
    expect(text("{{#each tags}}#{{ this }} {{/each}}by {{ name }}", { tags: ["a", "b"], name: "Ada" })).toBe(
      "#a #b by Ada",
    )
    expect(
      text("{{#each rows}}{{ this.n }}{{#if @first}}!{{/if}} {{/each}}", { rows: [{ n: 1 }, { n: 2 }] }),
    ).toBe("1! 2 ")
  })

  it("shows or hides on a condition, with Handlebars truthiness", () => {
    const source = "{{#if goal}}Goal: {{ goal }}{{else}}No goal{{/if}}{{#unless pro}} (free){{/unless}}"
    expect(text(source, { goal: "Product", pro: true })).toBe("Goal: Product")
    for (const empty of [undefined, null, false, 0, "", []])
      expect(text(source, { goal: empty, pro: empty })).toBe("No goal (free)")
    expect(text("{{#if user.plan}}{{ user.plan }}{{/if}}", { user: { plan: "pro" } })).toBe("pro")
  })

  it("nests sections, and escapes values in bodies but never re-reads them as template", () => {
    const source = "{{#each groups}}<h2>{{ name }}</h2>{{#each items}}<p>{{ this }}</p>{{/each}}{{/each}}"
    expect(
      html(source, {
        groups: [
          { name: "<A>", items: ["x & y", "{{#each evil}}"] },
          { name: "B", items: [] },
        ],
      }),
    ).toBe("<h2>&lt;A&gt;</h2><p>x &amp; y</p><p>{{#each evil}}</p><h2>B</h2>")
    // Plain placeholders render exactly as before.
    expect(html('Hi {{ name ?? "there" }}, {{ data.plan }}', { data: { plan: "pro" } })).toBe("Hi there, pro")
  })

  it("reports which data a template needs: section contents are optional, loop items aren't data", () => {
    expect(
      variablesOf(
        "Hi {{ name }}",
        "{{#if goal}}{{ goal }}{{/if}}{{#each courses}}{{ title }}{{ this.x }}{{/each}}",
      ),
    ).toEqual({
      used: ["courses", "goal", "name"],
      required: ["name"],
    })
  })

  it("names the line of a section that's broken, and refuses to save such a template", async () => {
    const broken = (source: string) => {
      try {
        parseTemplate(source)
        return null
      } catch (e) {
        return e instanceof TemplateSyntaxError ? e.message : String(e)
      }
    }
    expect(broken("a\n{{#each xs}}\nb")).toBe("Line 2: {{#each xs}} is never closed.")
    expect(broken("{{#if a}}{{/each}}")).toBe("Line 1: {{/each}} closes {{#if a}} from line 1.")
    expect(broken("x\n\n{{/if}}")).toBe("Line 3: {{/if}} closes nothing.")
    expect(broken("{{else}}")).toBe("Line 1: {{else}} outside a section.")
    expect(validateTemplate({ kind: "html", subject: "Hi {{#if x}}", source: "<p>ok</p>" })).toBe(
      "Line 1: {{#if x}} is never closed.",
    )
    const res = await call("/v1/templates", {
      method: "POST",
      key: ADMIN,
      json: {
        name: `broken-${crypto.randomUUID().slice(0, 6)}`,
        kind: "html",
        subject: "S",
        source: "{{#each a}}<p>",
      },
    })
    expect(res.status).toBe(400)
  })
})

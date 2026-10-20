import { describe, expect, it } from "vitest"
import { parseSearch, stringifySearch } from "./search.ts"

describe("search params like the API's", () => {
  it("writes lists as repeated keys and keeps commas and colons readable", () => {
    expect(
      stringifySearch({
        status: "subscribed,unconfirmed",
        field: ["plan:eq:pro", "country:eq:NG"],
        event: ["!x:30"],
      }),
    ).toBe("?status=subscribed,unconfirmed&field=plan:eq:pro&field=country:eq:NG&event=!x:30")
  })
  it("reads them back, a repeated key as a list", () => {
    expect(parseSearch("?status=subscribed,unconfirmed&field=plan:eq:pro&field=country:eq:NG")).toEqual({
      status: "subscribed,unconfirmed",
      field: ["plan:eq:pro", "country:eq:NG"],
    })
  })
  it("leaves everything else to the router's defaults", () => {
    expect(stringifySearch({ setup: 1, step: "csv" })).toBe("?setup=1&step=csv")
    expect(parseSearch("?setup=1")).toEqual({ setup: 1 })
    expect(stringifySearch({})).toBe("")
  })
})

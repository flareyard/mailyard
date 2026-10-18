import { defineConfig } from "vitest/config"

/** Pure logic runs in Node; component tests opt into jsdom with `// @vitest-environment jsdom`. */
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "node" },
})

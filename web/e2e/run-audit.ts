/**
 * `bun run audit` (root: `bun run check:ui`): the responsive audit (responsive-web skill) over every page, as a test.
 *
 * Builds the app in fixture mode, so every screen renders real-shaped data with no backend, serves the
 * production build with `vite preview`, and runs e2e/responsive-audit.mjs with --assert twice: once at device
 * sizes (phones, a phone on its side, tablets both ways, desktops) and once at browser zoom levels. It fails on
 * any horizontal overflow, crushed text, or a touch target under 24 px. Frames and the report land in
 * test-results/audit/. WebKit: run the same with AUDIT_ENGINE=webkit inside Microsoft's Playwright image.
 */
import { spawn, spawnSync } from "node:child_process"
import path from "node:path"

const root = path.join(import.meta.dirname, "..")
const port = process.env.AUDIT_PORT ?? "4319"
const base = `http://localhost:${port}`
const engine = process.env.AUDIT_ENGINE === "webkit" ? "webkit" : "chromium"

const run = (cmd: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } })
  return r.status ?? 1
}

if (run("bunx", ["vite", "build", "--outDir", "dist-audit"], { VITE_FIXTURES: "1" }) !== 0) process.exit(1)

const server = spawn("bunx", ["vite", "preview", "--outDir", "dist-audit", "--port", port, "--strictPort"], {
  cwd: root,
  stdio: "ignore",
})
const stop = () => server.kill("SIGTERM")
process.on("exit", stop)

let up = false
for (let i = 0; i < 50 && !up; i++) {
  await new Promise((r) => setTimeout(r, 200))
  up = await fetch(base).then(
    (r) => r.ok,
    () => false,
  )
}
if (!up) {
  console.error(`vite preview didn't answer on ${base}`)
  process.exit(1)
}

const audit = (extra: string[], out: string) =>
  run("node", [
    "e2e/responsive-audit.mjs",
    "--base",
    base,
    "--pages-file",
    "e2e/pages.txt",
    "--anon",
    "--assert",
    "--engine",
    engine,
    "--out",
    `test-results/audit/${engine}-${out}`,
    ...extra,
  ])

const devices = audit([], "devices")
const zoom = audit(["--zoom"], "zoom")
stop()
process.exit(devices || zoom)

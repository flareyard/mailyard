/**
 * Sample values for a template's variables. The API keeps no sample data, so they're a per-viewer convenience
 * kept in this browser (and in memory when storage refuses), shaping only the preview and the test send.
 */
import { fixturesEnabled } from "../../fixtures/mode.ts"
import { FIXTURE_SAMPLES } from "../fixtures.ts"

const key = (id: string) => `mailyard-template-samples:${id}`
const memory = new Map<string, Record<string, string>>()

export function readSamples(id: string): Record<string, string> {
  const hit = memory.get(id)
  if (hit) return hit
  try {
    const raw = localStorage.getItem(key(id))
    if (raw) {
      const v = JSON.parse(raw) as unknown
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const clean = Object.fromEntries(
          Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string"),
        ) as Record<string, string>
        memory.set(id, clean)
        return clean
      }
    }
  } catch {}
  return fixturesEnabled() ? { ...(FIXTURE_SAMPLES[id] ?? {}) } : {}
}

export function writeSamples(id: string, values: Record<string, string>) {
  memory.set(id, values)
  try {
    localStorage.setItem(key(id), JSON.stringify(values))
  } catch {}
}

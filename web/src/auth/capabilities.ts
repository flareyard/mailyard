/**
 * Which backend routes are live, read from the API's own /openapi.json. Screens that depend on a route the
 * backend is still building (sessions HAL-3358, the Flareyard handoff HAL-3360) light up by themselves the
 * moment it deploys, instead of carrying a flag someone has to remember to flip.
 */
import { useQuery } from "@tanstack/react-query"
import { fixturesEnabled } from "../fixtures/mode.ts"

type Spec = { paths: Record<string, Record<string, unknown>> }

export function useCapabilities() {
  const q = useQuery({
    queryKey: ["openapi"],
    queryFn: async (): Promise<Spec> => {
      const r = await fetch("/openapi.json", { credentials: "omit" })
      if (!r.ok) throw new Error(`openapi.json answered ${r.status}`)
      return (await r.json()) as Spec
    },
    staleTime: 10 * 60_000,
    enabled: !fixturesEnabled(),
  })
  const has = (method: string, path: string) =>
    fixturesEnabled() ? true : Boolean(q.data?.paths[path]?.[method.toLowerCase()])
  return {
    ready: fixturesEnabled() || q.isSuccess || q.isError,
    has,
    reachable: fixturesEnabled() || q.isSuccess,
  }
}

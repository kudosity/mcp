/**
 * Live OpenAPI spec loader — fetches the current Kudosity API specs from the
 * hosted developer portal so discovery tools always reflect the latest docs.
 * Specs are cached in memory for a short TTL to avoid refetching on every call.
 */
type Spec = {
  info?: { title?: string; version?: string; description?: string };
  servers?: { url?: string }[];
  paths?: Record<string, Record<string, any>>;
};

const SPEC_URLS: Record<string, string> = {
  "Transmit Message API":
    process.env.KUDOSITY_SPEC_V2_URL || "https://developers.kudosity.com/openapi/public-openapi.yaml",
  "Transmit SMS API":
    process.env.KUDOSITY_SPEC_V1_URL || "https://developers.kudosity.com/openapi/api_documentation.yml",
};

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; specs: Record<string, Spec> } | null = null;

export async function loadSpecs(): Promise<Record<string, Spec>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.specs;
  const specs: Record<string, Spec> = {};
  await Promise.all(
    Object.entries(SPEC_URLS).map(async ([title, url]) => {
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (res.ok) specs[title] = (await res.json()) as Spec;
      } catch {
        /* skip a spec that fails to load; others still work */
      }
    }),
  );
  cache = { at: Date.now(), specs };
  return specs;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

export interface EndpointMatch {
  spec: string;
  path: string;
  method: string;
  summary?: string;
}

/** Iterate every operation across all (or one) spec. */
export function forEachOperation(
  specs: Record<string, Spec>,
  fn: (m: EndpointMatch & { op: any }) => void,
  specFilter?: string,
): void {
  for (const [title, spec] of Object.entries(specs)) {
    if (specFilter && title !== specFilter) continue;
    for (const [path, methods] of Object.entries(spec.paths || {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (!HTTP_METHODS.has(method.toLowerCase()) || typeof op !== "object") continue;
        fn({ spec: title, path, method: method.toUpperCase(), summary: op.summary, op });
      }
    }
  }
}

import { HealthResponse } from "@ghostrider/shared";

export type HealthResult =
  | { kind: "reachable"; health: HealthResponse }
  | { kind: "unreachable"; error: string }
  | { kind: "invalid"; error: string };

type Deps = { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };

export async function getHealth({
  baseUrl = process.env.API_URL ?? "http://localhost:4000",
  fetch: fetchImpl = fetch,
  timeoutMs = 2000,
}: Deps = {}): Promise<HealthResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      kind: "unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // A 503 (degraded) still has a valid HealthResponse body, so parse it whatever the status.
  const parsed = HealthResponse.safeParse(await res.json().catch(() => null));
  return parsed.success
    ? { kind: "reachable", health: parsed.data }
    : {
        kind: "invalid",
        error: `HTTP ${res.status}: body did not match HealthResponse`,
      };
}

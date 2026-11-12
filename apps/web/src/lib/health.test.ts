import type { HealthResponse } from "@ghostrider/shared";
import { describe, expect, it, vi } from "vitest";
import { getHealth } from "./health";

const baseUrl = "http://api.test";

const healthy: HealthResponse = {
  status: "ok",
  checks: { postgres: "ok", redis: "ok" },
  version: "1.2.3",
  timestamp: "2026-11-11T20:00:00.000Z",
};

const degraded: HealthResponse = {
  ...healthy,
  status: "degraded",
  checks: { postgres: "ok", redis: "down" },
};

function respondWith(body: unknown, status = 200): typeof fetch {
  return async () => Response.json(body, { status });
}

describe("getHealth", () => {
  it("calls GET /health on the configured base URL, uncached", async () => {
    const fetch = vi.fn(respondWith(healthy));
    await getHealth({ baseUrl, fetch });
    expect(fetch).toHaveBeenCalledWith(
      "http://api.test/health",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("returns reachable/ok for a healthy 200", async () => {
    const result = await getHealth({ baseUrl, fetch: respondWith(healthy) });
    expect(result).toEqual({ kind: "reachable", health: healthy });
  });

  it("still parses the body of a 503 as reachable/degraded", async () => {
    const result = await getHealth({
      baseUrl,
      fetch: respondWith(degraded, 503),
    });
    expect(result).toEqual({ kind: "reachable", health: degraded });
  });

  it("returns unreachable when the request fails", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await getHealth({ baseUrl, fetch });
    expect(result).toEqual({ kind: "unreachable", error: "fetch failed" });
  });

  it("returns unreachable when the API hangs past the timeout", async () => {
    // Never resolves on its own; only settles when the timeout aborts it.
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    const result = await getHealth({ baseUrl, fetch, timeoutMs: 10 });
    expect(result.kind).toBe("unreachable");
  });

  it("returns invalid when the body does not match HealthResponse", async () => {
    const result = await getHealth({
      baseUrl,
      fetch: respondWith({ hello: "world" }, 500),
    });
    expect(result).toMatchObject({ kind: "invalid" });
    expect(result.kind === "invalid" && result.error).toContain("HTTP 500");
  });

  it("returns invalid when the body is not JSON", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response("<html>Bad Gateway</html>", { status: 502 });
    const result = await getHealth({ baseUrl, fetch });
    expect(result).toMatchObject({ kind: "invalid" });
  });
});

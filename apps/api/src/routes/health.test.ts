import { HealthResponse } from "@ghostrider/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const up = async () => {};
const down = async () => {
  throw new Error("connection refused");
};
const hangs = () => new Promise<void>(() => {});

async function getHealth(deps: Parameters<typeof buildApp>[0]) {
  const app = buildApp(deps);
  const res = await app.inject({ method: "GET", url: "/health" });
  await app.close();
  return { statusCode: res.statusCode, body: HealthResponse.parse(res.json()) };
}

describe("GET /health", () => {
  it("returns 200 when every dependency is up", async () => {
    const { statusCode, body } = await getHealth({
      postgres: up,
      redis: up,
      version: "test",
    });
    expect(statusCode).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("returns 503 and names the dependency that is down", async () => {
    const { statusCode, body } = await getHealth({
      postgres: up,
      redis: down,
      version: "test",
    });
    expect(statusCode).toBe(503);
    expect(body.checks).toEqual({ postgres: "ok", redis: "down" });
  });

  it("treats a hanging dependency as down instead of hanging", async () => {
    const { statusCode, body } = await getHealth({
      postgres: hangs,
      redis: up,
      version: "test",
    });
    expect(statusCode).toBe(503);
    expect(body.checks.postgres).toBe("down");
  });
});

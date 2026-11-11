import { describe, expect, it } from "vitest";
import { HealthResponse } from "./health.js";

const healthy = {
  status: "ok",
  checks: { postgres: "ok", redis: "ok" },
  version: "0.0.0",
  timestamp: new Date().toISOString(),
};

describe("HealthResponse", () => {
  it("accepts a healthy response", () => {
    expect(HealthResponse.safeParse(healthy).success).toBe(true);
  });

  it("rejects an unknown dependency status", () => {
    const bad = { ...healthy, checks: { postgres: "maybe", redis: "ok" } };
    expect(HealthResponse.safeParse(bad).success).toBe(false);
  });
});

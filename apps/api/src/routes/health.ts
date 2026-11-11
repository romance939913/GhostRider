import type { HealthResponse } from "@ghostrider/shared";
import type { FastifyPluginAsync } from "fastify";

export type HealthCheck = () => Promise<void>;

export interface HealthDeps {
  postgres: HealthCheck;
  redis: HealthCheck;
  version: string;
}

const CHECK_TIMEOUT_MS = 1_000;

// A dependency that hangs must not hang /health. Treat a slow check as "down".
async function run(check: HealthCheck): Promise<"ok" | "down"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("health check timed out")),
      CHECK_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([check(), timeout]);
    return "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

export const healthRoutes: FastifyPluginAsync<HealthDeps> = async (
  app,
  deps,
) => {
  app.get("/health", async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      run(deps.postgres),
      run(deps.redis),
    ]);
    const body: HealthResponse = {
      status: postgres === "ok" && redis === "ok" ? "ok" : "degraded",
      checks: { postgres, redis },
      version: deps.version,
      timestamp: new Date().toISOString(),
    };
    return reply.code(body.status === "ok" ? 200 : 503).send(body);
  });
};

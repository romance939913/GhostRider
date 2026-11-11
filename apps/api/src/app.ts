import Fastify from "fastify";
import { type HealthDeps, healthRoutes } from "./routes/health.js";

export function buildApp(deps: HealthDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.register(healthRoutes, deps);
  return app;
}

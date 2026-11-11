import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0"; // 0.0.0.0, not localhost, so Docker can reach it

// Stubs until step 4 wires up real Postgres and Redis clients.
const app = buildApp({
  postgres: async () => {},
  redis: async () => {},
  version: process.env.APP_VERSION ?? "dev",
});

// Graceful shutdown: finish in-flight requests before exiting (Docker sends SIGTERM).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

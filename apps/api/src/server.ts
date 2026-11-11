import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPostgres } from "./infra/postgres.js";
import { createRedis } from "./infra/redis.js";

const config = loadConfig();
const pg = createPostgres(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);

const app = buildApp({
  postgres: async () => {
    await pg.query("SELECT 1");
  },
  redis: async () => {
    await redis.ping();
  },
  version: config.APP_VERSION,
});

// Both clients emit "error" events when a connection drops. In Node, an
// "error" event with no listener crashes the process, so always listen.
pg.on("error", (err) => app.log.error({ err }, "postgres pool error"));
redis.on("error", (err) => app.log.warn({ err }, "redis connection error"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await Promise.allSettled([pg.end(), redis.quit()]);
    process.exit(0);
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

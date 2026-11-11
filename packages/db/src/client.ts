import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

// Takes an existing pool so the API can share one pool between Drizzle
// queries and its /health check, instead of opening two.
export function createDb(pool: Pool) {
  return drizzle({ client: pool });
}

export type Db = ReturnType<typeof createDb>;

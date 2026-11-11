import pg from "pg";

export function createPostgres(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2_000,
  });
}

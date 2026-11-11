import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  APP_VERSION: z.string().default("dev"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = Env.safeParse(env);
  if (!result.success) {
    console.error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
    process.exit(1);
  }
  return result.data;
}

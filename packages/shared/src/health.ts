import { z } from "zod";

export const DependencyStatus = z.enum(["ok", "down"]);

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.object({
    postgres: DependencyStatus,
    redis: DependencyStatus,
  }),
  version: z.string(),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof HealthResponse>;

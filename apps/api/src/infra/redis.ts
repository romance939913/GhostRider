import { Redis } from "ioredis";

export function createRedis(url: string) {
  // Fail fast for API requests. BullMQ workers will get their own connection
  // with maxRetriesPerRequest: null, which BullMQ requires.
  return new Redis(url, { maxRetriesPerRequest: 1 });
}

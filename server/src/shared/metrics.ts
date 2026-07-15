import type Redis from 'ioredis';
import { METRIC } from './keys.js';

/** Thin wrapper over Redis INCR so the guarantees are countable from anywhere. */
export function bumpMetric(redis: Redis, key: string, by = 1): void {
  // fire-and-forget; metrics must never slow the hot path
  redis.incrby(key, by).catch(() => {});
}

export async function readAllMetrics(redis: Redis): Promise<Record<string, number>> {
  const names = Object.values(METRIC);
  const vals = await redis.mget(...names);
  const out: Record<string, number> = {};
  Object.keys(METRIC).forEach((k, i) => {
    out[k] = Number(vals[i] ?? 0);
  });
  return out;
}

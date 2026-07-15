import Redis from 'ioredis';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * ioredis with sane retry so services survive `docker compose up` ordering
 * (Redis may not be ready the instant a worker boots).
 */
export function makeRedis(name = 'redis'): Redis {
  const client = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null, // required for blocking stream reads (XREADGROUP BLOCK)
    retryStrategy: (times) => Math.min(times * 200, 2000),
    lazyConnect: false,
  });
  client.on('error', (err) => log.warn(`redis error (${name})`, { err: String(err) }));
  return client;
}

export async function waitForRedis(client: Redis): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await client.ping();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('redis not reachable');
}

/**
 * Create a consumer group idempotently (MKSTREAM so the stream is created too).
 * BUSYGROUP just means someone already created it — safe to ignore.
 */
/**
 * True backlog for a consumer group = its `lag` (undelivered entries after the
 * last-delivered id). Unlike XLEN this shrinks as the group catches up, so it's
 * the honest "buffer depth" for the spike-absorber story. Falls back to 0.
 */
export async function streamLag(client: Redis, stream: string, group: string): Promise<number> {
  try {
    const groups = (await client.xinfo('GROUPS', stream)) as unknown[][];
    for (const g of groups) {
      let name: string | undefined;
      let lag: number | null = null;
      for (let i = 0; i < g.length; i += 2) {
        if (g[i] === 'name') name = g[i + 1] as string;
        if (g[i] === 'lag') lag = g[i + 1] === null ? null : Number(g[i + 1]);
      }
      if (name === group) return lag ?? 0;
    }
  } catch {
    /* stream/group not created yet */
  }
  return 0;
}

export async function ensureGroup(client: Redis, stream: string, group: string): Promise<void> {
  try {
    await client.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    log.info('created consumer group', { stream, group });
  } catch (err) {
    if (!String(err).includes('BUSYGROUP')) throw err;
  }
}

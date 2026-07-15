import Redis from 'ioredis';
import { makeRedis, waitForRedis, ensureGroup } from './redis.js';
import { parseEntries, type StreamEntry } from './streamutil.js';
import { log } from './logger.js';
import { config } from './config.js';

interface ConsumerParams<T> {
  stream: string;
  group: string;
  consumer?: string;
  batch: number;
  /**
   * Process a batch fully. The loop ACKs the batch ONLY after this resolves —
   * so a crash before/while handling leaves entries pending (at-least-once).
   * Sinks are idempotent (ULID-keyed writes, conditional notif claim), so
   * at-least-once + idempotent == effectively exactly-once.
   */
  handle: (entries: StreamEntry<T>[]) => Promise<void>;
  blockMs?: number;
  /** reclaim entries pending longer than this (crashed consumer recovery) */
  idleReclaimMs?: number;
}

/**
 * Generic Redis Streams consumer-group loop with XAUTOCLAIM-based recovery.
 * This is the reusable spine of the drain / fanout / notify workers.
 */
export async function runStreamConsumer<T>(params: ConsumerParams<T>): Promise<void> {
  const { stream, group, batch, handle } = params;
  const consumer = params.consumer ?? config.instanceId;
  const blockMs = params.blockMs ?? 5000;
  const idleReclaimMs = params.idleReclaimMs ?? 30000;

  // A dedicated connection for blocking reads; a second for acks/claims.
  const reader = makeRedis(`${group}:reader`);
  const admin = makeRedis(`${group}:admin`);
  await waitForRedis(reader);
  await ensureGroup(admin, stream, group);

  log.info('consumer started', { stream, group, consumer });
  let claimCursor = '0-0';
  let sinceReclaim = 0;

  async function processRaw(raw: [string, string[]][]): Promise<void> {
    if (!raw || raw.length === 0) return;
    const entries = parseEntries<T>(raw);
    if (entries.length === 0) {
      // Nothing parseable but still pending — ack to avoid poison-looping.
      await admin.xack(stream, group, ...raw.map((r) => r[0]));
      return;
    }
    await handle(entries);
    await admin.xack(stream, group, ...entries.map((e) => e.id));
  }

  for (;;) {
    try {
      // Periodically reclaim stale pending entries from dead consumers.
      if (Date.now() - sinceReclaim > idleReclaimMs) {
        sinceReclaim = Date.now();
        const claimed = (await admin.xautoclaim(
          stream, group, consumer, idleReclaimMs, claimCursor, 'COUNT', batch,
        )) as [string, [string, string[]][], string[]];
        claimCursor = claimed[0] || '0-0';
        if (claimed[1]?.length) {
          log.warn('reclaimed pending entries', { stream, group, n: claimed[1].length });
          await processRaw(claimed[1]);
        }
      }

      const resp = (await reader.xreadgroup(
        'GROUP', group, consumer, 'COUNT', batch, 'BLOCK', blockMs, 'STREAMS', stream, '>',
      )) as [string, [string, string[]][]][] | null;

      if (!resp) continue;
      for (const [, raw] of resp) await processRaw(raw);
    } catch (err) {
      log.error('consumer loop error', { stream, group, err: String(err) });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

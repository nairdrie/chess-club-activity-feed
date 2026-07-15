import { config } from '../shared/config.js';
import { log } from '../shared/logger.js';
import { makeRedis } from '../shared/redis.js';
import { getPool, waitForMysql, ensureSchema } from '../shared/mysql.js';
import { runStreamConsumer } from '../shared/consumer.js';
import { STREAM_INGEST, GROUP_DRAIN, METRIC } from '../shared/keys.js';
import { bumpMetric } from '../shared/metrics.js';
import type { ActivityEvent } from '../shared/types.js';

/**
 * DRAIN WORKER — batched, durable persist off the write-path buffer.
 *
 * For each ingest entry we write the domain row AND the outbox row in ONE
 * transaction (transactional outbox = no-loss guarantee). Only after the DB
 * commit does the consumer loop ACK the buffer entry ("write DB first, then
 * remove from buffer" — the fix to the loss window seen in prod).
 */
const metrics = makeRedis('drain-metrics');

async function persist(events: ActivityEvent[]): Promise<void> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Bulk multi-row inserts (one round-trip each) instead of 2×N statements.
    // INSERT IGNORE => re-delivered entries (at-least-once) are idempotent.
    const eventRows = events.map((ev) => [
      ev.id, ev.clubId, ev.type, ev.actorId, ev.actorName, ev.clubName, ev.text, ev.memberCount, ev.createdAt,
    ]);
    const outboxRows = events.map((ev) => [ev.id, ev.clubId, JSON.stringify(ev), 0, ev.createdAt]);
    await conn.query(
      `INSERT IGNORE INTO events
         (id, club_id, type, actor_id, actor_name, club_name, text, member_count, created_at)
       VALUES ?`,
      [eventRows],
    );
    await conn.query(
      `INSERT INTO outbox (event_id, club_id, payload, published, created_at) VALUES ?`,
      [outboxRows],
    );
    await conn.commit();
    bumpMetric(metrics, METRIC.drained, events.length);
  } catch (err) {
    await conn.rollback();
    throw err; // do not ACK — entries stay pending and get retried/reclaimed
  } finally {
    conn.release();
  }
}

async function main() {
  await waitForMysql();
  await ensureSchema();
  log.info('drain worker up', { batch: config.drainBatch });
  await runStreamConsumer<ActivityEvent>({
    stream: STREAM_INGEST,
    group: GROUP_DRAIN,
    batch: config.drainBatch,
    handle: (entries) => persist(entries.map((e) => e.data)),
  });
}

main().catch((err) => {
  log.error('drain worker crashed', { err: String(err) });
  process.exit(1);
});

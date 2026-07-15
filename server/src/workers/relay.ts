import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { config } from '../shared/config.js';
import { log } from '../shared/logger.js';
import { makeRedis, waitForRedis } from '../shared/redis.js';
import { getPool, waitForMysql, ensureSchema } from '../shared/mysql.js';
import { xaddJson } from '../shared/streamutil.js';
import { STREAM_EVENTS, METRIC } from '../shared/keys.js';
import { bumpMetric } from '../shared/metrics.js';
import type { ActivityEvent } from '../shared/types.js';

/**
 * RELAY WORKER — the polling relay half of the transactional outbox.
 *
 * SELECT ... FOR UPDATE SKIP LOCKED lets many relay replicas share the outbox
 * with zero double-claiming. We publish to the event log (Redis Streams here,
 * a Kafka topic at scale — see README) and mark the row published in the same
 * tx. At-least-once publish; fanout consumers are idempotent, so it's safe.
 */
const redis = makeRedis('relay');

async function drainOutboxOnce(): Promise<number> {
  const pool = getPool();
  const conn: PoolConnection = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT seq, payload FROM outbox
        WHERE published = 0
        ORDER BY seq
        LIMIT ${config.relayBatch}
        FOR UPDATE SKIP LOCKED`,
    );
    if (rows.length === 0) {
      await conn.commit();
      return 0;
    }
    for (const r of rows) {
      const ev: ActivityEvent = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      await xaddJson(redis, STREAM_EVENTS, ev);
    }
    const seqs = rows.map((r) => r.seq);
    await conn.query(`UPDATE outbox SET published = 1 WHERE seq IN (${seqs.map(() => '?').join(',')})`, seqs);
    await conn.commit();
    bumpMetric(redis, METRIC.published, rows.length);
    return rows.length;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function main() {
  await waitForRedis(redis);
  await waitForMysql();
  await ensureSchema();
  log.info('relay worker up', { batch: config.relayBatch, pollMs: config.relayPollMs });
  for (;;) {
    try {
      const n = await drainOutboxOnce();
      // Back off only when idle; under load we loop hot to keep latency low.
      if (n === 0) await new Promise((r) => setTimeout(r, config.relayPollMs));
    } catch (err) {
      log.error('relay error', { err: String(err) });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

main().catch((err) => {
  log.error('relay worker crashed', { err: String(err) });
  process.exit(1);
});

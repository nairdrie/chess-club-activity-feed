/**
 * Central config, all from env so the same image runs as api / realtime / any worker.
 */
import os from 'node:os';

function num(name: string, def: number): number {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}
function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

export const config = {
  // identity — which role this process plays and a stable id for logs/metrics
  role: str('ROLE', 'api'),
  // Unique per container (hostname) so scaled worker replicas don't collide as
  // the same Redis Streams consumer name.
  instanceId: str('INSTANCE_ID', `${str('ROLE', 'api')}-${os.hostname()}`),
  port: num('PORT', 8080),

  // fanout strategy
  pushThreshold: num('PUSH_THRESHOLD', 5000),
  activeDays: num('ACTIVE_DAYS', 7),
  // Size of the "active in last N days" set we actually materialize/notify to.
  // In prod this is however many users are genuinely active; for a laptop demo
  // it keeps a 500k-member whale tractable while exercising the exact code path.
  activeSample: num('ACTIVE_SAMPLE', 50),

  // notification digesting — collapse "one notification per event" into
  // "one summary per (user, club, window)". The window length trades freshness
  // for volume; kept short here so a 30s load test flushes several windows.
  digestWindowMs: num('DIGEST_WINDOW_MS', 5000),
  digestPollMs: num('DIGEST_POLL_MS', 500),
  digestBatch: num('DIGEST_BATCH', 500),
  // High-priority event types that BYPASS the digest and deliver immediately
  // (comma-separated, e.g. "match_start"). Default empty so the demo shows the
  // full collapse; set IMMEDIATE_TYPES=match_start to exercise the bypass.
  immediateTypes: str('IMMEDIATE_TYPES', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // infra
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  mysql: {
    host: str('MYSQL_HOST', 'localhost'),
    port: num('MYSQL_PORT', 3306),
    user: str('MYSQL_USER', 'feed'),
    password: str('MYSQL_PASSWORD', 'feedpw'),
    database: str('MYSQL_DATABASE', 'activity'),
  },
  dynamo: {
    endpoint: str('DYNAMO_ENDPOINT', 'http://localhost:8000'),
    region: str('AWS_REGION', 'us-east-1'),
  },

  // tuning
  drainBatch: num('DRAIN_BATCH', 256),
  relayBatch: num('RELAY_BATCH', 256),
  relayPollMs: num('RELAY_POLL_MS', 50),

  // feed store shape
  userFeedCap: num('USER_FEED_CAP', 500),
  feedTtlDays: num('FEED_TTL_DAYS', 30),
  // How long the realtime emit-once guard remembers an event id. Only needs to
  // outlive the redelivery/reclaim window (idle-reclaim + a settle margin).
  emitDedupeTtlSec: num('EMIT_DEDUPE_TTL_SEC', 3600),

  // seed sizes
  whaleMembers: num('WHALE_MEMBERS', 500000),
  smallMembers: num('SMALL_MEMBERS', 1200),
};

export type Config = typeof config;

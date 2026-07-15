/**
 * Every Redis key / stream / consumer-group name lives here so the whole
 * system agrees on the contract. Streams are the event log; the annotation
 * (see README) is that each maps 1:1 to a Kafka topic at Chess.com scale.
 */

// ---- Streams (the log) ----
// Write-path buffer: API XADDs here and returns immediately (the spike absorber).
export const STREAM_INGEST = 'stream:ingest';
// Post-outbox fanout source. Partition key is club_id (see note in README).
export const STREAM_EVENTS = 'stream:events';
// Notification jobs (separate consumer group + DLQ for exactly-once delivery).
export const STREAM_NOTIFY = 'stream:notify';
export const STREAM_NOTIFY_DLQ = 'stream:notify:dlq';

// ---- Consumer groups ----
export const GROUP_DRAIN = 'cg:drain'; // ingest -> MySQL (domain + outbox)
export const GROUP_FANOUT = 'cg:fanout'; // events -> feed store + realtime + notifications
export const GROUP_NOTIFY = 'cg:notify'; // notify -> deliver (deduped)

// ---- Per-club sets ----
export const clubMeta = (clubId: string) => `club:${clubId}:meta`; // hash: name, memberCount, kind
export const clubMembers = (clubId: string) => `club:${clubId}:members`; // SET of userIds

// The single highest-ROI optimization: only materialize users active in last N days.
export const ACTIVE_USERS = 'active:users'; // SET of active userIds

// ---- Hot-feed cache ----
// ZSET score = ULID time, member = JSON(FeedItem). noeviction on this instance.
export const feedCache = (userId: string) => `cache:feed:${userId}`;

// ---- Metrics counters (INCR) — the guarantees made observable ----
export const METRIC = {
  ingested: 'metrics:ingested', // events accepted by API
  drained: 'metrics:drained', // events durably written to MySQL (domain+outbox)
  published: 'metrics:published', // outbox rows relayed to stream:events
  fanned: 'metrics:fanned', // events processed by fanout
  materialized: 'metrics:materialized', // per-user feed rows written (push)
  timelineWrites: 'metrics:timeline_writes', // club_timeline rows written
  notifyEnqueued: 'metrics:notify_enqueued',
  notifyDelivered: 'metrics:notify_delivered',
  notifyDeduped: 'metrics:notify_deduped', // exactly-once blocks (the claim-race fix)
  notifyDlq: 'metrics:notify_dlq',
  realtimeEmitted: 'metrics:realtime_emitted',
} as const;

import { Emitter } from '@socket.io/redis-emitter';
import { config } from '../shared/config.js';
import { log } from '../shared/logger.js';
import { makeRedis, waitForRedis } from '../shared/redis.js';
import { runStreamConsumer } from '../shared/consumer.js';
import { STREAM_EVENTS, STREAM_NOTIFY, GROUP_FANOUT, METRIC, clubMembers, ACTIVE_USERS, feedCache } from '../shared/keys.js';
import { bumpMetric } from '../shared/metrics.js';
import { classifyKind } from '../shared/clubs.js';
import {
  ensureTables,
  batchPut,
  userFeedRow,
  clubTimelineRow,
  TABLE_USER_FEED,
  TABLE_CLUB_TIMELINE,
} from '../shared/dynamo.js';
import { prefsKey, parsePrefs, channelsFor, type CachedPrefs } from '../shared/prefs.js';
import { idTime } from '../shared/ids.js';
import type { ActivityEvent, FeedItem, ThinPayload } from '../shared/types.js';

/**
 * FANOUT WORKER — the core logic.
 *
 *   push (materialize user_feed)  for clubs under threshold
 *   pull (append club_timeline)   for whale clubs over it
 *   only touch users active in last N days  (SINTER members ∩ active set)
 *
 * Then push a THIN realtime payload to the club room and enqueue notifications
 * after a preference filter. The whole stream batch is processed together so we
 * resolve active members + prefs ONCE per club and flush Dynamo writes in
 * BatchWrites — the difference between ~500/s and many thousands/s per worker.
 */
const redis = makeRedis('fanout');
const pub = makeRedis('fanout-emitter');
const emitter = new Emitter(pub);

function toFeedItem(ev: ActivityEvent, via: 'push' | 'pull'): FeedItem {
  return {
    id: ev.id,
    eventId: ev.id,
    clubId: ev.clubId,
    clubName: ev.clubName,
    type: ev.type,
    actorId: ev.actorId,
    actorName: ev.actorName,
    text: ev.text,
    createdAt: ev.createdAt,
    via,
  };
}

/** SINTER club members ∩ active set — the highest-ROI optimization (whale: 500k→few). */
async function activeMembersOf(clubId: string): Promise<string[]> {
  return redis.sinter(clubMembers(clubId), ACTIVE_USERS);
}

/** One pipeline to fetch prefs for every member touched by this batch. */
async function loadPrefs(members: string[]): Promise<Map<string, CachedPrefs>> {
  const map = new Map<string, CachedPrefs>();
  if (members.length === 0) return map;
  const pipe = redis.pipeline();
  members.forEach((uid) => pipe.hgetall(prefsKey(uid)));
  const res = await pipe.exec();
  members.forEach((uid, i) => map.set(uid, parsePrefs((res?.[i]?.[1] as Record<string, string>) ?? {})));
  return map;
}

async function handleBatch(events: ActivityEvent[]): Promise<void> {
  // 1. Resolve active members per distinct club, once.
  const clubIds = [...new Set(events.map((e) => e.clubId))];
  const membersByClub = new Map<string, string[]>();
  await Promise.all(clubIds.map(async (id) => membersByClub.set(id, await activeMembersOf(id))));

  // 2. Fetch prefs for every touched member, once (the preference filter input).
  const allMembers = [...new Set([...membersByClub.values()].flat())];
  const prefs = await loadPrefs(allMembers);

  // 3. Emit realtime immediately (cheap; keeps live latency off the Dynamo path)
  //    while accumulating batched writes.
  const timelineRows: Record<string, unknown>[] = [];
  const userFeedRows: Record<string, unknown>[] = [];
  const cachePipe = redis.pipeline();
  const notifyPipe = redis.pipeline();
  let materialized = 0;
  let timelineWrites = 0;
  let notifyEnqueued = 0;

  for (const ev of events) {
    const members = membersByClub.get(ev.clubId) ?? [];
    const kind = classifyKind(ev.memberCount);
    const item = toFeedItem(ev, kind);

    if (kind === 'push') {
      for (const uid of members) {
        userFeedRows.push(userFeedRow(uid, item));
        cachePipe.zadd(feedCache(uid), idTime(item.id), JSON.stringify(item));
        cachePipe.zremrangebyrank(feedCache(uid), 0, -(config.userFeedCap + 1));
      }
      materialized += members.length;
    } else {
      timelineRows.push(clubTimelineRow(item));
      timelineWrites += 1;
    }

    const thin: ThinPayload = { eventId: ev.id, cursor: ev.id, clubId: ev.clubId, type: ev.type, createdAt: ev.createdAt };
    emitter.to(`club:${ev.clubId}`).emit('activity', thin);

    // preference filter (cheapest reducer) → enqueue only enabled channels
    for (const uid of members) {
      for (const channel of channelsFor(prefs.get(uid)!, ev.clubId)) {
        notifyPipe.xadd(
          STREAM_NOTIFY, 'MAXLEN', '~', '3000000', '*',
          'data', JSON.stringify({ eventId: ev.id, clubId: ev.clubId, userId: uid, channel, type: ev.type }),
        );
        notifyEnqueued += 1;
      }
    }
  }

  // 4. Flush everything concurrently.
  await Promise.all([
    timelineRows.length ? batchPut(TABLE_CLUB_TIMELINE, timelineRows) : Promise.resolve(),
    userFeedRows.length ? batchPut(TABLE_USER_FEED, userFeedRows) : Promise.resolve(),
    cachePipe.length ? cachePipe.exec() : Promise.resolve(),
    notifyPipe.length ? notifyPipe.exec() : Promise.resolve(),
  ]);

  bumpMetric(redis, METRIC.realtimeEmitted, events.length);
  bumpMetric(redis, METRIC.fanned, events.length);
  if (materialized) bumpMetric(redis, METRIC.materialized, materialized);
  if (timelineWrites) bumpMetric(redis, METRIC.timelineWrites, timelineWrites);
  if (notifyEnqueued) bumpMetric(redis, METRIC.notifyEnqueued, notifyEnqueued);
}

async function main() {
  await waitForRedis(redis);
  await ensureTables();
  log.info('fanout worker up', { pushThreshold: config.pushThreshold });
  await runStreamConsumer<ActivityEvent>({
    stream: STREAM_EVENTS,
    group: GROUP_FANOUT,
    batch: 256,
    handle: (entries) => handleBatch(entries.map((e) => e.data)),
  });
}

main().catch((err) => {
  log.error('fanout worker crashed', { err: String(err) });
  process.exit(1);
});

import { ulid } from 'ulid';
import { config } from './shared/config.js';
import { log } from './shared/logger.js';
import { makeRedis, waitForRedis } from './shared/redis.js';
import { getPool, waitForMysql, ensureSchema } from './shared/mysql.js';
import { ensureTables, batchPutUserFeed, putTimeline } from './shared/dynamo.js';
import { clubMembers, ACTIVE_USERS, clubMeta } from './shared/keys.js';
import { saveClubMeta, classifyKind } from './shared/clubs.js';
import { savePrefs } from './shared/prefs.js';
import { DEMO_USER_ID, WHALE_CLUB_ID, SMALL_CLUB_IDS, EVENT_TEMPLATES, pickActor } from './shared/demo.js';
import { EVENT_TYPES, type Club, type FeedItem, type EventType } from './shared/types.js';

/**
 * Seeds the demo:
 *  - clubs (one 500k-member whale => PULL, two small => PUSH)
 *  - the demo user's memberships (so getUserClubs works)
 *  - Redis: club meta, per-club ACTIVE member set (the bounded fan set),
 *    the global active-users set, and default prefs for active users
 *  - a little backdated feed history so the UI isn't empty on first load
 *
 * Note: we do NOT insert 500k membership rows. The whole point of the active-set
 * optimization is that only active users are ever materialized/notified, so the
 * fan set == the active set. member_count on the club is just the headline number
 * that drives the push/pull decision.
 */
const redis = makeRedis('seed');

function clubs(): Club[] {
  return [
    { id: WHALE_CLUB_ID, name: 'Team USA (Whale)', memberCount: config.whaleMembers, kind: classifyKind(config.whaleMembers) },
    { id: SMALL_CLUB_IDS[0], name: 'Knights of the Round Board', memberCount: config.smallMembers, kind: classifyKind(config.smallMembers) },
    { id: SMALL_CLUB_IDS[1], name: 'Rookies Rising', memberCount: 320, kind: classifyKind(320) },
  ];
}

function activeMembersFor(clubId: string): string[] {
  const ids = [DEMO_USER_ID];
  for (let i = 0; i < config.activeSample; i++) ids.push(`u_m_${clubId}_${i}`);
  return ids;
}

async function seedClub(c: Club): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO clubs (id, name, member_count, created_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), member_count = VALUES(member_count)`,
    [c.id, c.name, c.memberCount, Date.now()],
  );
  // demo user is a member of every club
  await pool.query('INSERT IGNORE INTO memberships (club_id, user_id) VALUES (?, ?)', [c.id, DEMO_USER_ID]);

  await saveClubMeta(redis, c);

  // Redis active member set for this club (bounded) + global active set + prefs.
  const members = activeMembersFor(c.id);
  const pipe = redis.pipeline();
  pipe.del(clubMembers(c.id));
  pipe.sadd(clubMembers(c.id), ...members);
  pipe.sadd(ACTIVE_USERS, ...members);
  await pipe.exec();
  for (const uid of members) {
    await savePrefs(redis, uid, { inApp: true, email: uid === DEMO_USER_ID, push: false, mutedClubs: [] });
  }
  log.info('seeded club', { id: c.id, kind: c.kind, memberCount: c.memberCount, activeMembers: members.length });
}

async function seedHistory(cs: Club[]): Promise<void> {
  // A handful of backdated events per club so the feed has content on load.
  const now = Date.now();
  let n = 0;
  for (const c of cs) {
    const members = activeMembersFor(c.id);
    for (let i = 0; i < 6; i++) {
      const ts = now - (cs.length * 6 - n) * 60_000; // staggered over the last hour+
      const type = EVENT_TYPES[(n + i) % EVENT_TYPES.length] as EventType;
      const actor = pickActor(n + i);
      const id = ulid(ts);
      const item: FeedItem = {
        id,
        eventId: id,
        clubId: c.id,
        clubName: c.name,
        type,
        actorId: actor.id,
        actorName: actor.name,
        text: EVENT_TEMPLATES[type](actor.name),
        createdAt: ts,
        via: c.kind,
      };
      if (c.kind === 'push') await batchPutUserFeed(members, item);
      else await putTimeline(item);
      n++;
    }
  }
  log.info('seeded history', { events: n });
}

async function main() {
  await waitForRedis(redis);
  await waitForMysql();
  await ensureSchema();
  await ensureTables();
  const cs = clubs();
  for (const c of cs) await seedClub(c);
  await seedHistory(cs);
  // default prefs for the demo user in MySQL too (source of truth for the CRUD API)
  await getPool().query(
    `INSERT INTO preferences (user_id, in_app, email, push, muted_clubs)
     VALUES (?, 1, 1, 0, '[]')
     ON DUPLICATE KEY UPDATE user_id = user_id`,
    [DEMO_USER_ID],
  );
  log.info('seed complete');
  await redis.quit();
  process.exit(0);
}

main().catch((err) => {
  log.error('seed failed', { err: String(err) });
  process.exit(1);
});

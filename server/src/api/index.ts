import express, { type Request, type Response } from 'express';
import cors from 'cors';
import type { RowDataPacket } from 'mysql2';
import { config } from '../shared/config.js';
import { log } from '../shared/logger.js';
import { newId } from '../shared/ids.js';
import { makeRedis, waitForRedis, streamLag } from '../shared/redis.js';
import { getPool, waitForMysql, ensureSchema } from '../shared/mysql.js';
import { ensureTables } from '../shared/dynamo.js';
import { xaddJson } from '../shared/streamutil.js';
import { STREAM_INGEST, STREAM_EVENTS, STREAM_NOTIFY, GROUP_DRAIN, GROUP_FANOUT, GROUP_NOTIFY, METRIC } from '../shared/keys.js';
import { bumpMetric, readAllMetrics } from '../shared/metrics.js';
import { loadClubMeta, listClubs, getUserClubs } from '../shared/clubs.js';
import { savePrefs } from '../shared/prefs.js';
import { EVENT_TYPES, type ActivityEvent, type EventType, type Preferences } from '../shared/types.js';
import { DEMO_USER_ID, DEMO_USER_NAME, EVENT_TEMPLATES, pickActor } from '../shared/demo.js';
import { getFeedPage } from './feed.js';

const redis = makeRedis('api');
let actorSeed = 0;

const app = express();
app.use(cors());
app.use(express.json());

const ok = (res: Response, body: unknown) => res.json(body);
const bad = (res: Response, code: number, msg: string) => res.status(code).json({ error: msg });

app.get('/health', (_req, res) => ok(res, { ok: true, role: config.role, id: config.instanceId }));

app.get('/me', async (_req, res) => {
  const clubs = await getUserClubs(DEMO_USER_ID);
  ok(res, { userId: DEMO_USER_ID, name: DEMO_USER_NAME, clubIds: clubs.map((c) => c.id) });
});

app.get('/clubs', async (_req, res) => {
  ok(res, await listClubs());
});

/**
 * INGEST — the spike absorber. XADD to the write-path buffer and return
 * immediately. We never touch MySQL/Dynamo on the request path; club meta is
 * read from a Redis hash (O(1)). The drain worker persists asynchronously.
 */
app.post('/events', async (req: Request, res: Response) => {
  const { clubId, type, text, actorName } = req.body ?? {};
  if (!clubId || !type || !EVENT_TYPES.includes(type)) {
    return bad(res, 400, 'clubId and a valid type are required');
  }
  const club = await loadClubMeta(redis, clubId);
  if (!club) return bad(res, 404, `unknown club ${clubId}`);

  const actor = actorName ? { id: `u_${String(actorName).toLowerCase()}`, name: String(actorName) } : pickActor(actorSeed++);
  const id = newId();
  const ev: ActivityEvent = {
    id,
    clubId,
    clubName: club.name,
    type: type as EventType,
    actorId: actor.id,
    actorName: actor.name,
    text: text || EVENT_TEMPLATES[type](actor.name),
    createdAt: Date.now(),
    memberCount: club.memberCount,
  };

  await xaddJson(redis, STREAM_INGEST, ev);
  bumpMetric(redis, METRIC.ingested);
  ok(res, { accepted: true, eventId: id });
});

/** FEED read — push/pull merge, cursor pagination. */
app.get('/feed', async (req: Request, res: Response) => {
  const userId = String(req.query.userId || DEMO_USER_ID);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const before = req.query.before ? String(req.query.before) : undefined;
  const after = req.query.after ? String(req.query.after) : undefined;
  try {
    const page = await getFeedPage(userId, { limit, before, after });
    ok(res, page);
  } catch (err) {
    log.error('feed read failed', { err: String(err) });
    bad(res, 500, 'feed read failed');
  }
});

// ---- Preferences CRUD ----
app.get('/preferences', async (req, res) => {
  const userId = String(req.query.userId || DEMO_USER_ID);
  const [rows] = await getPool().query<RowDataPacket[]>('SELECT * FROM preferences WHERE user_id = :userId', {
    userId,
  });
  if (!rows.length) {
    const def: Preferences = { userId, inApp: true, email: true, push: false, mutedClubs: [] };
    return ok(res, def);
  }
  const r = rows[0];
  ok(res, {
    userId,
    inApp: !!r.in_app,
    email: !!r.email,
    push: !!r.push,
    mutedClubs: typeof r.muted_clubs === 'string' ? JSON.parse(r.muted_clubs) : r.muted_clubs ?? [],
  });
});

app.put('/preferences', async (req, res) => {
  const { userId = DEMO_USER_ID, inApp = true, email = true, push = false, mutedClubs = [] } = req.body ?? {};
  await getPool().query(
    `INSERT INTO preferences (user_id, in_app, email, push, muted_clubs)
     VALUES (:userId, :inApp, :email, :push, :mutedClubs)
     ON DUPLICATE KEY UPDATE in_app=:inApp, email=:email, push=:push, muted_clubs=:mutedClubs`,
    { userId, inApp: inApp ? 1 : 0, email: email ? 1 : 0, push: push ? 1 : 0, mutedClubs: JSON.stringify(mutedClubs) },
  );
  // Mirror into the Redis prefs cache so the fanout hot path sees the change.
  await savePrefs(redis, userId, { inApp, email, push, mutedClubs });
  ok(res, { userId, inApp, email, push, mutedClubs });
});

/** METRICS — the guarantees, made observable. Includes live buffer depth. */
app.get('/metrics', async (_req, res) => {
  const [m, bufferDepth, eventsBacklog, notifyBacklog] = await Promise.all([
    readAllMetrics(redis),
    streamLag(redis, STREAM_INGEST, GROUP_DRAIN),
    streamLag(redis, STREAM_EVENTS, GROUP_FANOUT),
    streamLag(redis, STREAM_NOTIFY, GROUP_NOTIFY),
  ]);
  ok(res, { ...m, bufferDepth, eventsBacklog, notifyBacklog });
});

async function main() {
  await waitForRedis(redis);
  await waitForMysql();
  // API also ensures schema/tables so a bare `docker compose up` is self-initializing.
  await ensureSchema();
  await ensureTables();
  app.listen(config.port, () => log.info(`api listening on :${config.port}`));
}

main().catch((err) => {
  log.error('api failed to start', { err: String(err) });
  process.exit(1);
});

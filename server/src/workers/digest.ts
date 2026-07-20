import { config } from '../shared/config.js';
import { log } from '../shared/logger.js';
import { makeRedis, waitForRedis } from '../shared/redis.js';
import { STREAM_NOTIFY, DIGEST_DUE, METRIC, userDigest } from '../shared/keys.js';
import { bumpMetric } from '../shared/metrics.js';
import { prefsKey, parsePrefs, channelsFor } from '../shared/prefs.js';
import { loadClubMeta } from '../shared/clubs.js';

/**
 * DIGEST SCHEDULER — the second notification reducer.
 *
 * Fanout coalesces events into per-user counters (`digest:{user}` hash, one field
 * per club) and registers a flush deadline in a due-set ZSET. This worker pops the
 * due-set (`ZRANGEBYSCORE <= now`) to find exactly WHO is ready — never scanning
 * all users — reads their counters (WHAT), and emits ONE summary per (user, club)
 * onto stream:notify. Volume drops from users × events to users × windows.
 *
 * Each digest is keyed (user, club, window) so the same exactly-once dedupe + DLQ
 * at the notify sink apply — a window is delivered once or not at all.
 */
const redis = makeRedis('digest');

// Atomic read-and-clear of a user's counter hash. Doing HGETALL + DEL in one
// script means an event landing mid-flush is either fully included in this window
// or starts a fresh one — never dropped, never double-counted.
const FLUSH_LUA = `
local vals = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return vals`;

async function flushUser(userId: string, windowClose: number): Promise<void> {
  const flat = (await redis.eval(FLUSH_LUA, 1, userDigest(userId))) as string[];
  if (!flat || flat.length === 0) return; // raced empty (already flushed) — harmless

  // Re-derive channels at flush time so a preference change during the window is
  // respected. In-app is the live badge; email/push are the digested channels —
  // here every enabled channel gets one summary for a uniform, dedupable sink.
  const prefs = parsePrefs(await redis.hgetall(prefsKey(userId)));

  const pipe = redis.pipeline();
  let emitted = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const clubId = flat[i];
    const count = Number(flat[i + 1]);
    const channels = channelsFor(prefs, clubId);
    if (channels.length === 0) continue;
    const club = await loadClubMeta(redis, clubId);
    const clubName = club?.name ?? clubId;
    for (const channel of channels) {
      pipe.xadd(
        STREAM_NOTIFY, 'MAXLEN', '~', '3000000', '*',
        'data', JSON.stringify({ kind: 'digest', userId, clubId, clubName, channel, count, window: windowClose }),
      );
      emitted += 1;
    }
  }
  if (emitted) {
    await pipe.exec();
    bumpMetric(redis, METRIC.notifyEnqueued, emitted);
    bumpMetric(redis, METRIC.digestFlushed, emitted);
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  // Peek due users with their window-close score, then claim each with ZREM.
  const due = (await redis.zrangebyscore(
    DIGEST_DUE, '-inf', now, 'WITHSCORES', 'LIMIT', 0, config.digestBatch * 2,
  )) as string[];
  if (due.length === 0) return;

  const flushes: Promise<void>[] = [];
  for (let i = 0; i < due.length; i += 2) {
    const userId = due[i];
    const windowClose = Number(due[i + 1]);
    // Atomic claim: only the worker whose ZREM removes the member flushes it, so
    // multiple scheduler replicas never double-process the same user.
    const won = await redis.zrem(DIGEST_DUE, userId);
    if (won === 1) flushes.push(flushUser(userId, windowClose));
  }
  await Promise.all(flushes);
}

async function main() {
  await waitForRedis(redis);
  log.info('digest scheduler up', { windowMs: config.digestWindowMs, pollMs: config.digestPollMs });
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log.error('digest tick error', { err: String(err) });
    }
    await new Promise((r) => setTimeout(r, config.digestPollMs));
  }
}

main().catch((err) => {
  log.error('digest scheduler crashed', { err: String(err) });
  process.exit(1);
});

import { io, type Socket } from 'socket.io-client';
import { WHALE_CLUB_ID, SMALL_CLUB_IDS } from '../shared/demo.js';
import { EVENT_TYPES } from '../shared/types.js';

/**
 * LOAD GENERATOR — fire N events/sec into one club and prove the guarantees.
 *
 * It is BOTH a producer (POST /events) and a consumer (a socket.io client in
 * the club room). Because it sees every event it fired come back over the
 * realtime path, it can compute end-to-end latency, duplicates (must be 0) and
 * lost events (must be 0) directly — no trust required.
 */
const HTTP = process.env.TARGET_HTTP || 'http://localhost:8080';
const WS = process.env.TARGET_WS || HTTP;
const PREFIX = process.env.API_PREFIX ?? '/api';
const RATE = Number(process.env.LOAD_RATE || 2000);
const SECONDS = Number(process.env.LOAD_SECONDS || 20);
const CLUB = (() => {
  const c = process.env.LOAD_CLUB || 'whale';
  if (c === 'whale') return WHALE_CLUB_ID;
  if (c === 'small') return SMALL_CLUB_IDS[0];
  return c;
})();

const api = (p: string) => `${HTTP}${PREFIX}${p}`;

const fired = new Set<string>();
const received = new Set<string>();
let duplicates = 0;
let inflight = 0;
let firedCount = 0;
let recvCount = 0;
let latSum = 0;
let latMax = 0;
let latN = 0;
let lastLatency = 0;

async function getMetrics(): Promise<Record<string, number>> {
  try {
    const r = await fetch(api('/metrics'));
    return (await r.json()) as Record<string, number>;
  } catch {
    return {};
  }
}

function connectSocket(): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = io(WS, { transports: ['websocket'], reconnection: true });
    socket.on('connect', () => {
      socket.emit('join', { userId: 'loadgen', clubIds: [CLUB] });
    });
    socket.on('joined', () => resolve(socket));
    socket.on('activity', (p: { eventId: string; createdAt: number }) => {
      recvCount++;
      if (received.has(p.eventId)) duplicates++;
      else received.add(p.eventId);
      const lat = Date.now() - p.createdAt;
      lastLatency = lat;
      latSum += lat;
      latMax = Math.max(latMax, lat);
      latN++;
    });
    // safety: resolve even if 'joined' is missed
    setTimeout(() => resolve(socket), 1500);
  });
}

async function fireOne(): Promise<void> {
  inflight++;
  try {
    const type = EVENT_TYPES[(Math.random() * EVENT_TYPES.length) | 0];
    const r = await fetch(api('/events'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clubId: CLUB, type }),
    });
    if (r.ok) {
      const { eventId } = (await r.json()) as { eventId: string };
      fired.add(eventId);
      firedCount++;
    }
  } catch {
    /* transient; the point is sustained pressure, a few drops on the client side are fine */
  } finally {
    inflight--;
  }
}

function bar(label: string, value: string) {
  return `${label.padEnd(18)} ${value}`;
}

async function main() {
  console.log(`\n⚡ Load generator → club=${CLUB}  rate=${RATE}/s  duration=${SECONDS}s  target=${HTTP}\n`);
  const socket = await connectSocket();

  const start = Date.now();
  const tickMs = 50;
  const perTick = Math.max(1, Math.round((RATE * tickMs) / 1000));
  let prevDrained = 0;
  let prevT = Date.now();

  const firing = setInterval(() => {
    if (Date.now() - start >= SECONDS * 1000) {
      clearInterval(firing);
      return;
    }
    // simple in-flight cap so a slow API back-pressures the generator, not the box
    if (inflight > RATE) return;
    for (let i = 0; i < perTick; i++) void fireOne();
  }, tickMs);

  const dash = setInterval(async () => {
    const m = await getMetrics();
    const now = Date.now();
    const drained = m.drained ?? 0;
    const drainRate = Math.round(((drained - prevDrained) / (now - prevT)) * 1000);
    prevDrained = drained;
    prevT = now;
    const avgLat = latN ? Math.round(latSum / latN) : 0;
    const elapsed = ((now - start) / 1000).toFixed(0);
    console.clear();
    console.log(`⚡ Load: club=${CLUB} rate=${RATE}/s  elapsed=${elapsed}s/${SECONDS}s\n`);
    console.log(bar('fired', String(firedCount)));
    console.log(bar('delivered (rt)', String(received.size)));
    console.log(bar('buffer depth', String(m.bufferDepth ?? 0)) + '   (stream:ingest backlog)');
    console.log(bar('events backlog', String(m.eventsBacklog ?? 0)));
    console.log(bar('drain rate', `${drainRate}/s`));
    console.log('');
    console.log(bar('drained (db)', String(m.drained ?? 0)));
    console.log(bar('published', String(m.published ?? 0)));
    console.log(bar('fanned', String(m.fanned ?? 0)));
    console.log(bar('materialized', String(m.materialized ?? 0)));
    console.log(bar('timeline writes', String(m.timelineWrites ?? 0)));
    console.log(bar('digest folded', String(m.digestCoalesced ?? 0)) + '   (events → counters)');
    console.log(bar('digest summaries', String(m.digestFlushed ?? 0)));
    console.log(bar('notify delivered', String(m.notifyDelivered ?? 0)) + '   (immediate + digests)');
    console.log('');
    console.log(bar('e2e latency', `last=${lastLatency}ms avg=${avgLat}ms max=${latMax}ms`));
    console.log('');
    console.log('── guarantees ' + '─'.repeat(30));
    console.log(bar('duplicates', duplicates === 0 ? '0  ✅' : `${duplicates}  ❌`));
    console.log(bar('notify deduped', String(m.notifyDeduped ?? 0)) + '   (exactly-once blocks)');
    console.log(bar('DLQ', String(m.notifyDlq ?? 0)));
  }, 1000);

  // Wait for firing to finish, then a drain grace period, then final report.
  await new Promise((r) => setTimeout(r, SECONDS * 1000 + 500));
  console.log('\n⏳ firing complete — draining pipeline for reconciliation...');
  // Wait until the event pipeline is fully drained (fanout backlog == 0) AND the
  // realtime consumer has caught up to everything we fired. Deadline scales with
  // how much is still in flight so a single-node demo still reaches a clean 0/0.
  const settleDeadline = Date.now() + 180000;
  let stableTicks = 0;
  while (Date.now() < settleDeadline) {
    const mm = await getMetrics();
    const backlog = (mm.eventsBacklog ?? 0) + (mm.bufferDepth ?? 0);
    const caughtUp = received.size >= fired.size;
    if (backlog === 0 && caughtUp) {
      if (++stableTicks >= 2) break; // confirm it stays settled
    } else {
      stableTicks = 0;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  clearInterval(dash);
  await new Promise((r) => setTimeout(r, 300));

  const lostIds = [...fired].filter((id) => !received.has(id));
  const m = await getMetrics();
  console.clear();
  console.log('══════════════════════════════════════════════');
  console.log('  LOAD TEST REPORT');
  console.log('══════════════════════════════════════════════');
  console.log(bar('club', CLUB));
  console.log(bar('target rate', `${RATE}/s for ${SECONDS}s`));
  console.log(bar('fired', String(fired.size)));
  console.log(bar('delivered (realtime)', String(received.size)));
  console.log('');
  console.log(bar('end-to-end latency', `avg=${latN ? Math.round(latSum / latN) : 0}ms  max=${latMax}ms`));
  console.log(bar('final buffer depth', String(m.bufferDepth ?? 0)));
  console.log(bar('drained→db', String(m.drained ?? 0)));
  console.log(bar('fanned', String(m.fanned ?? 0)));
  console.log(bar('digest folded', String(m.digestCoalesced ?? 0)));
  console.log(bar('digest summaries', String(m.digestFlushed ?? 0)));
  console.log(bar('notify delivered', String(m.notifyDelivered ?? 0)));
  console.log(bar('notify deduped', String(m.notifyDeduped ?? 0)));
  console.log('');
  console.log('── GUARANTEES ' + '─'.repeat(32));
  console.log(bar('DUPLICATES', duplicates === 0 ? '0  ✅ (zero duplication)' : `${duplicates}  ❌`));
  console.log(bar('LOST', lostIds.length === 0 ? '0  ✅ (zero loss)' : `${lostIds.length}  ❌`));
  console.log('══════════════════════════════════════════════');
  if (lostIds.length) console.log('lost sample:', lostIds.slice(0, 5));

  socket.close();
  process.exit(lostIds.length === 0 && duplicates === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('loadgen failed', err);
  process.exit(1);
});

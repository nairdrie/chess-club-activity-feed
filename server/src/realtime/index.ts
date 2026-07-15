import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { config } from '../shared/config.js';
import { log } from '../shared/logger.js';
import { makeRedis, waitForRedis } from '../shared/redis.js';
import { ACTIVE_USERS } from '../shared/keys.js';

/**
 * REALTIME TIER — one socket.io pod (run 3 in the demo).
 *
 *  - one room per club: `club:{id}`, joined on the client's `join` message
 *  - @socket.io/redis-adapter fans a broadcast across ALL pods, so an event
 *    emitted by a worker (via redis-emitter) reaches every member's socket
 *    regardless of which pod they landed on.
 *  - we push only the thin payload; the client backfills the body via REST.
 */
const pub = makeRedis('rt-pub');
const sub = pub.duplicate();

async function main() {
  await waitForRedis(pub);

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'realtime', id: config.instanceId }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io = new Server(httpServer, {
    cors: { origin: '*' },
    // long-polling fallback works because the LB pins sessions (sticky).
    transports: ['websocket', 'polling'],
  });
  io.adapter(createAdapter(pub, sub));

  io.on('connection', (socket) => {
    socket.on('join', async (payload: { userId?: string; clubIds?: string[] }) => {
      const clubIds = payload?.clubIds ?? [];
      for (const id of clubIds) socket.join(`club:${id}`);
      if (payload?.userId) {
        socket.join(`user:${payload.userId}`);
        // A live connection counts as "active" — feeds the highest-ROI optimization.
        pub.sadd(ACTIVE_USERS, payload.userId).catch(() => {});
      }
      socket.emit('joined', { rooms: clubIds, pod: config.instanceId });
      log.debug('socket joined', { clubs: clubIds.length, pod: config.instanceId });
    });
  });

  httpServer.listen(config.port, () => log.info(`realtime pod listening on :${config.port}`, { pod: config.instanceId }));
}

main().catch((err) => {
  log.error('realtime failed to start', { err: String(err) });
  process.exit(1);
});

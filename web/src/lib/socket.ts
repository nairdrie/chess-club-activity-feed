import { io, Socket } from 'socket.io-client';

// Connect to the same origin using the default socket.io path. No URL arg so
// it works behind the LB in production and via the Vite ws proxy in dev.
//
// WebSocket-only (no polling): polling needs every HTTP request to land on the
// same pod (sticky sessions), which forces the LB into ip_hash and reintroduces
// the stale-IP routing problem. A single WS connection stays on one pod and the
// redis-adapter fans broadcasts across pods, so stickiness isn't needed.
export function createSocket(): Socket {
  return io({
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  });
}

import { io, Socket } from 'socket.io-client';

// Connect to the same origin using the default socket.io path. No URL arg so
// it works behind the LB in production and via the Vite ws proxy in dev.
export function createSocket(): Socket {
  return io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  });
}

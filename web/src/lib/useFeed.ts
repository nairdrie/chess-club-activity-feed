import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getFeed, getMe } from './api';
import { createSocket } from './socket';
import type { ActivityPayload, ClientStats, FeedItem, Me } from './types';

const PAGE_SIZE = 20;

export interface UseFeed {
  me: Me | null;
  items: FeedItem[];
  loadingInitial: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  connected: boolean;
  error: string | null;
  stats: ClientStats;
  liveCount: number;
  loadMore: () => void;
  resetLiveCount: () => void;
}

export function useFeed(): UseFeed {
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveCount, setLiveCount] = useState(0);
  const [stats, setStats] = useState<ClientStats>({
    delivered: 0,
    duplicates: 0,
    lost: 0,
    lastLatencyMs: null,
    avgLatencyMs: null,
  });

  // Refs so socket handlers always read current values without re-binding.
  const meRef = useRef<Me | null>(null);
  const newestCursorRef = useRef<string | null>(null); // top (newest) item id
  const oldestCursorRef = useRef<string | null>(null); // bottom (oldest) item id
  const seenItemIds = useRef<Set<string>>(new Set());
  const seenEventIds = useRef<Set<string>>(new Set());
  const latencySamples = useRef<number[]>([]);
  const backfillInFlight = useRef(false);
  const backfillPending = useRef(false);
  const socketRef = useRef<Socket | null>(null);

  // Prepend newer items (dedup by id), updating the newest cursor.
  const prependItems = useCallback((incoming: FeedItem[]) => {
    if (incoming.length === 0) return;
    const fresh = incoming.filter((it) => !seenItemIds.current.has(it.id));
    if (fresh.length === 0) return;
    fresh.forEach((it) => seenItemIds.current.add(it.id));
    // incoming is newest-first; keep the list newest-first.
    setItems((prev) => [...fresh, ...prev]);
    // newest item id becomes the new "after" cursor.
    newestCursorRef.current = fresh[0].id;
    if (!oldestCursorRef.current) {
      oldestCursorRef.current = fresh[fresh.length - 1].id;
    }
    setLiveCount((n) => n + fresh.length);
  }, []);

  // Append older items (dedup by id), updating the oldest cursor.
  const appendItems = useCallback((incoming: FeedItem[]) => {
    const fresh = incoming.filter((it) => !seenItemIds.current.has(it.id));
    if (fresh.length === 0) return;
    fresh.forEach((it) => seenItemIds.current.add(it.id));
    setItems((prev) => [...prev, ...fresh]);
    oldestCursorRef.current = fresh[fresh.length - 1].id;
    if (!newestCursorRef.current) {
      newestCursorRef.current = fresh[0].id;
    }
  }, []);

  // REST backfill of items newer than what we have (after the socket pings us
  // or on reconnect). Coalesces concurrent requests.
  const backfill = useCallback(async () => {
    const currentMe = meRef.current;
    if (!currentMe) return;
    if (backfillInFlight.current) {
      backfillPending.current = true;
      return;
    }
    backfillInFlight.current = true;
    try {
      const after = newestCursorRef.current;
      const page = await getFeed({
        userId: currentMe.userId,
        limit: PAGE_SIZE,
        // If we have no cursor yet, this returns the newest page.
        ...(after ? { after } : {}),
      });
      prependItems(page.items);
    } catch {
      // transient; next activity/reconnect will retry
    } finally {
      backfillInFlight.current = false;
      if (backfillPending.current) {
        backfillPending.current = false;
        void backfill();
      }
    }
  }, [prependItems]);

  // Initial load: me -> first feed page -> socket.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meResp = await getMe();
        if (cancelled) return;
        meRef.current = meResp;
        setMe(meResp);

        const page = await getFeed({
          userId: meResp.userId,
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        appendItems(page.items);
        setHasMore(page.hasMore);
        setLoadingInitial(false);

        // Connect realtime.
        const socket = createSocket();
        socketRef.current = socket;

        const doJoin = () => {
          socket.emit('join', {
            userId: meResp.userId,
            clubIds: meResp.clubIds,
          });
        };

        socket.on('connect', () => {
          setConnected(true);
          doJoin();
          // On (re)connect, backfill any gap before resuming.
          void backfill();
        });

        socket.on('disconnect', () => setConnected(false));

        socket.on('activity', (payload: ActivityPayload) => {
          // (a) observability: delivered / duplicates / latency
          const now = Date.now();
          // e2e latency crosses two clocks (server stamps createdAt, browser
          // stamps receipt). Host/container clock skew can make idle latencies
          // slightly negative; clamp to 0 so sub-skew values read as ~instant.
          // Under load (hundreds of ms+) the skew is negligible.
          const latency = Math.max(0, now - payload.createdAt);
          latencySamples.current.push(latency);
          if (latencySamples.current.length > 200) {
            latencySamples.current.shift();
          }
          const samples = latencySamples.current;
          const avg =
            samples.reduce((a, b) => a + b, 0) / Math.max(samples.length, 1);

          setStats((prev) => {
            const isDup = seenEventIds.current.has(payload.eventId);
            if (!isDup) seenEventIds.current.add(payload.eventId);
            return {
              delivered: prev.delivered + (isDup ? 0 : 1),
              duplicates: prev.duplicates + (isDup ? 1 : 0),
              lost: prev.lost,
              lastLatencyMs: latency,
              avgLatencyMs: Math.round(avg),
            };
          });

          // (b) backfill the real item(s) via REST (thin payload design).
          void backfill();
        });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load feed');
        setLoadingInitial(false);
      }
    })();

    return () => {
      cancelled = true;
      socketRef.current?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = useCallback(() => {
    const currentMe = meRef.current;
    if (!currentMe) return;
    if (loadingMore || !hasMore) return;
    const before = oldestCursorRef.current;
    if (!before) return;
    setLoadingMore(true);
    getFeed({ userId: currentMe.userId, limit: PAGE_SIZE, before })
      .then((page) => {
        appendItems(page.items);
        setHasMore(page.hasMore);
      })
      .catch(() => {
        /* leave hasMore; user can scroll to retry */
      })
      .finally(() => setLoadingMore(false));
  }, [appendItems, hasMore, loadingMore]);

  const resetLiveCount = useCallback(() => setLiveCount(0), []);

  return {
    me,
    items,
    loadingInitial,
    loadingMore,
    hasMore,
    connected,
    error,
    stats,
    liveCount,
    loadMore,
    resetLiveCount,
  };
}

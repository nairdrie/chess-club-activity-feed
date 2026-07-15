export type EventType =
  | 'member_join'
  | 'match_start'
  | 'poll_open'
  | 'announcement';

export type Via = 'push' | 'pull';

export interface Club {
  id: string;
  name: string;
  memberCount: number;
  kind: Via;
}

export interface Me {
  userId: string;
  name: string;
  clubIds: string[];
}

export interface FeedItem {
  id: string; // ULID cursor
  eventId: string;
  clubId: string;
  clubName: string;
  type: EventType;
  actorId: string;
  actorName: string;
  text: string;
  createdAt: number; // epoch ms
  via: Via;
}

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Preferences {
  userId: string;
  inApp: boolean;
  email: boolean;
  push: boolean;
  mutedClubs: string[];
}

// Thin realtime payload emitted by the server on the `activity` event.
export interface ActivityPayload {
  eventId: string;
  cursor: string;
  clubId: string;
  type: EventType;
  createdAt: number;
}

export type Metrics = Record<string, number>;

export interface ClientStats {
  delivered: number; // unique realtime eventIds since load
  duplicates: number; // eventIds seen more than once
  lost: number; // kept 0 unless computable
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
}

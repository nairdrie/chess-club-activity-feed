export type EventType = 'member_join' | 'match_start' | 'poll_open' | 'announcement';

export const EVENT_TYPES: EventType[] = ['member_join', 'match_start', 'poll_open', 'announcement'];

export type ClubKind = 'push' | 'pull';

export interface Club {
  id: string;
  name: string;
  memberCount: number;
  kind: ClubKind;
}

/** Canonical domain event. `id` is a ULID minted at ingest. */
export interface ActivityEvent {
  id: string;
  clubId: string;
  clubName: string;
  type: EventType;
  actorId: string;
  actorName: string;
  text: string;
  createdAt: number; // epoch ms, stamped at ingest
  memberCount: number; // snapshot so fanout can decide push/pull without a DB hit
}

/** What the read path returns and what the UI renders. */
export interface FeedItem {
  id: string; // == event ULID, also the cursor
  eventId: string;
  clubId: string;
  clubName: string;
  type: EventType;
  actorId: string;
  actorName: string;
  text: string;
  createdAt: number;
  via: 'push' | 'pull'; // provenance, so the demo can show which path served the row
}

/** Thin realtime payload — id + cursor only. Client backfills the body via REST. */
export interface ThinPayload {
  eventId: string;
  cursor: string;
  clubId: string;
  type: EventType;
  createdAt: number;
}

export interface Preferences {
  userId: string;
  inApp: boolean;
  email: boolean;
  push: boolean;
  mutedClubs: string[];
}

export type NotificationChannel = 'in_app' | 'email' | 'push';

export type NotificationKind = 'event' | 'digest';

/**
 * A job on stream:notify. Two shapes share the sink so exactly-once dedupe + DLQ
 * apply uniformly:
 *  - kind 'event'  — one immediate notification for a single high-priority event.
 *  - kind 'digest' — one coalesced summary for a (user, club, window).
 */
export interface NotificationJob {
  kind: NotificationKind;
  userId: string;
  clubId: string;
  channel: NotificationChannel;
  // event jobs (immediate / high-priority bypass):
  eventId?: string;
  type?: EventType;
  // digest jobs (window summary):
  clubName?: string;
  count?: number;
  window?: number; // window-close epoch ms; part of the (user, club, window) dedupe key
}

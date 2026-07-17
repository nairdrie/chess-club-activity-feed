import { getUserClubs } from '../shared/clubs.js';
import { queryUserFeed, queryClubTimeline } from '../shared/dynamo.js';
import type { FeedItem } from '../shared/types.js';

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface Opts {
  limit: number;
  before?: string;
  after?: string;
}

/**
 * The push/pull merge — the heart of the read path.
 *  - PUSH clubs: rows are already materialized in user_feed (one query).
 *  - PULL clubs (whales): merge the club_timeline at read time.
 * Both are unified into one ULID-sorted page. `via` tags provenance for the demo.
 */
export async function getFeedPage(userId: string, opts: Opts): Promise<FeedPage> {
  const { limit, before, after } = opts;
  const clubs = await getUserClubs(userId);

  const pageOpts = { limit, before, after };

  // FAST PATH — the user's materialized feed (push clubs, active users). One
  // single-partition query returns all their push-club items pre-merged.
  const pushRows = (await queryUserFeed(userId, pageOpts)).map((i) => ({ ...i, via: 'push' as const }));

  // COMPLETENESS — club_timeline is the authoritative log for EVERY club, so we
  // merge the timeline of each club the user belongs to. This guarantees no
  // event is ever missed: inactive users (never materialized) and whale/pull
  // clubs (never materialized) are both reconstructed here. Items also present
  // in user_feed dedupe out below, with the materialized copy winning.
  const timelineResults = await Promise.all(
    clubs.map((c) =>
      queryClubTimeline(c.id, pageOpts).then((rows) => rows.map((i) => ({ ...i, via: 'pull' as const }))),
    ),
  );

  // push first so the materialized copy wins the dedupe (provenance = 'push' for
  // rows the user had materialized, 'pull' for rows reconstructed from timeline).
  const merged: FeedItem[] = [...pushRows, ...timelineResults.flat()];

  // Dedupe by id and sort newest-first (ULID desc).
  const seen = new Set<string>();
  const unique = merged.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  unique.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  if (after) {
    // Backfill: return everything newer than the cursor (bounded).
    const items = unique.slice(0, Math.max(limit, 100));
    return { items, nextCursor: items.length ? items[items.length - 1].id : null, hasMore: false };
  }

  const items = unique.slice(0, limit);
  const hasMore = unique.length > limit || items.length === limit;
  const nextCursor = items.length ? items[items.length - 1].id : null;
  return { items, nextCursor, hasMore };
}

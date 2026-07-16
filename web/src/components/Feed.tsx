import { useEffect, useRef, useState } from 'react';
import type { FeedItem } from '../lib/types';
import { FeedCard } from './FeedCard';

interface Props {
  items: FeedItem[];
  loadingInitial: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  liveCount: number;
  loadMore: () => void;
  resetLiveCount: () => void;
}

const NEAR_TOP_PX = 24;

export function Feed({
  items,
  loadingInitial,
  loadingMore,
  hasMore,
  error,
  liveCount,
  loadMore,
  resetLiveCount,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [atTop, setAtTop] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // Track which item ids we've already rendered, so only genuinely new
  // (live-prepended) cards get the entrance animation.
  const knownIds = useRef<Set<string>>(new Set());
  const initializedOnce = useRef(false);

  // Refresh relative timestamps periodically.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(id);
  }, []);

  // Always call the latest loadMore without making it an effect dependency
  // (its identity churns as hasMore/loadingMore change).
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // The sentinel only exists once the real list is rendered (not during
  // skeletons / empty / error). Re-attach when that becomes true AND after each
  // append (items.length changes) so chained loading continues while the
  // sentinel stays in view.
  const listMounted = !loadingInitial && !error && items.length > 0;

  // Infinite scroll via IntersectionObserver on a bottom sentinel.
  useEffect(() => {
    if (!listMounted) return;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { root, rootMargin: '300px 0px' }
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [listMounted, items.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nowAtTop = el.scrollTop <= NEAR_TOP_PX;
    setAtTop(nowAtTop);
    if (nowAtTop && liveCount > 0) resetLiveCount();
  };

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    resetLiveCount();
  };

  // Compute the new-id set for this render.
  const currentIds = new Set(items.map((i) => i.id));
  const isFirstFill = !initializedOnce.current && items.length > 0;
  const newlyArrived = new Set<string>();
  if (initializedOnce.current) {
    for (const it of items) {
      if (!knownIds.current.has(it.id)) newlyArrived.add(it.id);
    }
  }
  // Update known set after computing diff.
  knownIds.current = currentIds;
  if (isFirstFill) initializedOnce.current = true;

  const showPill = !atTop && liveCount > 0;

  return (
    <div className="feed-wrap">
      {showPill && (
        <button className="new-pill" onClick={scrollToTop}>
          ▲ {liveCount} new {liveCount === 1 ? 'activity' : 'activities'}
        </button>
      )}

      <div className="feed-scroll" ref={scrollRef} onScroll={onScroll}>
        {loadingInitial ? (
          <div className="feed-skeletons">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="skeleton-card" key={i}>
                <div className="skeleton-avatar" />
                <div className="skeleton-lines">
                  <div className="skeleton-line skeleton-line--sm" />
                  <div className="skeleton-line" />
                  <div className="skeleton-line skeleton-line--xs" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="feed-empty">
            <p className="feed-empty-title">Couldn’t load the feed</p>
            <p className="feed-empty-sub">{error}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="feed-empty">
            <p className="feed-empty-title">No activity yet</p>
            <p className="feed-empty-sub">
              Fire an event from Demo Controls to see it stream in.
            </p>
          </div>
        ) : (
          <>
            <div className="feed-list">
              {items.map((it) => (
                <FeedCard
                  key={it.id}
                  item={it}
                  now={now}
                  isNew={newlyArrived.has(it.id)}
                />
              ))}
            </div>

            <div className="feed-foot" ref={sentinelRef}>
              {loadingMore ? (
                <div className="spinner-row">
                  <span className="spinner" /> Loading older activity…
                </div>
              ) : hasMore ? (
                <span className="foot-hint">Scroll for more</span>
              ) : (
                <span className="foot-caught">You’re all caught up</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

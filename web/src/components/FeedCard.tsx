import { memo } from 'react';
import type { FeedItem } from '../lib/types';
import {
  avatarColor,
  EVENT_LABEL,
  EVENT_TITLE,
  initials,
  relativeTime,
} from '../lib/format';
import { EventIcon } from './icons';

interface Props {
  item: FeedItem;
  now: number;
  isNew?: boolean;
}

function FeedCardImpl({ item, now, isNew }: Props) {
  return (
    <article className={`feed-card ${isNew ? 'feed-card--enter' : ''}`}>
      <div className="feed-avatar-wrap">
        <span
          className="avatar avatar--club"
          style={{ background: avatarColor(item.clubId) }}
          aria-hidden="true"
        >
          {initials(item.clubName)}
        </span>
        <span className={`event-badge event-badge--${item.type}`} title={EVENT_TITLE[item.type]}>
          <EventIcon type={item.type} size={13} />
        </span>
      </div>

      <div className="feed-body">
        <div className="feed-head">
          <span className="feed-club">{item.clubName}</span>
          <span className="feed-type">· {EVENT_TITLE[item.type]}</span>
        </div>
        <p className="feed-text">
          <span className="feed-actor">{item.actorName}</span>{' '}
          {item.text?.trim() ? item.text : EVENT_LABEL[item.type]}
        </p>
        <div className="feed-meta">
          <span className="feed-time">{relativeTime(item.createdAt, now)}</span>
          <span className={`via-pill via-pill--${item.via}`} title={`Served via ${item.via} fanout`}>
            via {item.via}
          </span>
        </div>
      </div>
    </article>
  );
}

export const FeedCard = memo(FeedCardImpl);

import type { EventType } from './types';

export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deterministic pleasant color from an id, for avatar backgrounds.
const AVATAR_COLORS = [
  '#7a9e3a',
  '#4a90d9',
  '#c0713c',
  '#9b59b6',
  '#3aa89b',
  '#c0504d',
  '#d4a12c',
  '#5b6ea8',
];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export const EVENT_LABEL: Record<EventType, string> = {
  member_join: 'joined the club',
  match_start: 'a team match started',
  poll_open: 'opened a vote poll',
  announcement: 'posted an announcement',
};

export const EVENT_TITLE: Record<EventType, string> = {
  member_join: 'New member',
  match_start: 'Team match',
  poll_open: 'Vote poll',
  announcement: 'Announcement',
};

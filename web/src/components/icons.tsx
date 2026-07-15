import type { EventType } from '../lib/types';

interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export function IconPlay({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconPuzzle({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 7h4a1 1 0 0 0 1-1 2 2 0 1 1 4 0 1 1 0 0 0 1 1h4v4a1 1 0 0 1-1 1 2 2 0 1 0 0 4 1 1 0 0 1 1 1v4h-4a1 1 0 0 1-1-1 2 2 0 1 0-4 0 1 1 0 0 1-1 1H4v-4a1 1 0 0 1 1-1 2 2 0 1 0 0-4 1 1 0 0 1-1-1V7z" />
    </svg>
  );
}

export function IconLearn({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 6l9-3 9 3-9 3-9-3z" />
      <path d="M21 6v5" />
      <path d="M7 8.5V13c0 1.5 2.2 3 5 3s5-1.5 5-3V8.5" />
    </svg>
  );
}

export function IconWatch({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconNews({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 5h13v14H5a1 1 0 0 1-1-1V5z" />
      <path d="M17 8h3v9a2 2 0 0 1-2 2" />
      <path d="M7 9h7M7 12h7M7 15h4" />
    </svg>
  );
}

export function IconSocial({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <circle cx="17.5" cy="9.5" r="2.2" />
      <path d="M15 20a5 5 0 0 1 6.5-4.5" />
    </svg>
  );
}

export function IconMore({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconClub({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 21h16" />
      <path d="M6 21V10l6-5 6 5v11" />
      <path d="M10 21v-5h4v5" />
    </svg>
  );
}

export function IconGear({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconChevron({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// Pawn glyph for the wordmark logo.
export function IconPawn({ size = 26, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path
        d="M12 3a3 3 0 0 0-2.4 4.8A4 4 0 0 0 8 11c0 1.3.6 2.4 1.5 3.1L8 19h8l-1.5-4.9A4 4 0 0 0 16 11a4 4 0 0 0-1.6-3.2A3 3 0 0 0 12 3zM6 20h12v1.5H6z"
        fill="currentColor"
      />
    </svg>
  );
}

// ---- Event-type icons (feed cards) ----

export function EventIcon({
  type,
  size = 16,
}: {
  type: EventType;
  size?: number;
}) {
  switch (type) {
    case 'member_join':
      return (
        <svg {...base(size)}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3 20a6 6 0 0 1 12 0" />
          <path d="M18 8v6M15 11h6" />
        </svg>
      );
    case 'match_start':
      return (
        <svg {...base(size)}>
          <path d="M4 4l7 7M20 4l-7 7" />
          <path d="M11 11l-6 6-1 3 3-1 6-6" />
          <path d="M13 11l6 6 1 3-3-1-6-6" />
        </svg>
      );
    case 'poll_open':
      return (
        <svg {...base(size)}>
          <path d="M4 20V4" />
          <rect x="7" y="12" width="3" height="6" fill="currentColor" stroke="none" />
          <rect x="12" y="8" width="3" height="10" fill="currentColor" stroke="none" />
          <rect x="17" y="5" width="3" height="13" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'announcement':
      return (
        <svg {...base(size)}>
          <path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z" />
          <path d="M15 8a4 4 0 0 1 0 8" />
        </svg>
      );
  }
}

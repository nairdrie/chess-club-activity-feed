import {
  IconChevron,
  IconClub,
  IconGear,
  IconLearn,
  IconMore,
  IconNews,
  IconPawn,
  IconPlay,
  IconPuzzle,
  IconSocial,
  IconWatch,
} from './icons';
import type { Me } from '../lib/types';

interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

const TOP_ITEMS: NavItem[] = [
  { key: 'play', label: 'Play', icon: <IconPlay /> },
  { key: 'puzzles', label: 'Puzzles', icon: <IconPuzzle /> },
  { key: 'learn', label: 'Learn', icon: <IconLearn /> },
  { key: 'watch', label: 'Watch', icon: <IconWatch /> },
  { key: 'news', label: 'News', icon: <IconNews /> },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Sidebar({ me }: { me: Me | null }) {
  const displayName = me?.name ?? 'you';
  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <IconPawn size={28} />
        </span>
        <span className="brand-word">Chess.com</span>
      </div>

      <ul className="nav-list">
        {TOP_ITEMS.map((it) => (
          <li key={it.key} className="nav-item" aria-disabled="true">
            <span className="nav-icon">{it.icon}</span>
            <span className="nav-label">{it.label}</span>
          </li>
        ))}

        {/* Social — the active, expandable section */}
        <li className="nav-item nav-item--section is-open" aria-disabled="true">
          <span className="nav-icon">
            <IconSocial />
          </span>
          <span className="nav-label">Social</span>
          <span className="nav-chevron">
            <IconChevron size={16} />
          </span>
        </li>

        <li className="nav-sub">
          <div className="nav-subitem" aria-disabled="true">
            <span className="nav-icon nav-icon--sm">
              <IconClub size={18} />
            </span>
            <span className="nav-label">Clubs</span>
          </div>
          <div className="nav-subitem nav-subitem--deep is-active" aria-current="page">
            <span className="nav-active-bar" />
            <span className="nav-label">Activity</span>
          </div>
        </li>

        <li className="nav-item" aria-disabled="true">
          <span className="nav-icon">
            <IconMore />
          </span>
          <span className="nav-label">More</span>
        </li>
      </ul>

      <div className="sidebar-spacer" />

      <div className="user-chip" aria-disabled="true">
        <span className="avatar avatar--user">{initialsOf(displayName)}</span>
        <span className="user-name">{displayName}</span>
        <span className="user-gear">
          <IconGear size={18} />
        </span>
      </div>
    </nav>
  );
}

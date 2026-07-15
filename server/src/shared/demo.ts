/** Fixed identities so the demo is deterministic and the UI has a "current user". */
export const DEMO_USER_ID = 'u_you';
export const DEMO_USER_NAME = 'you';

export const WHALE_CLUB_ID = 'club_whale';
export const SMALL_CLUB_IDS = ['club_knights', 'club_rookies'];

export const ACTOR_NAMES = [
  'MagnusFan88', 'RookiePawn', 'QueenGambitQueen', 'KnightRider', 'BishopBash',
  'CastleCrasher', 'EnPassantEnjoyer', 'ZugzwangZoe', 'ForkMaster', 'PinPointPete',
  'SicilianSam', 'CaroKannCarl', 'BlitzBetty', 'BulletBob', 'EndgameEddie',
];

/** Deterministic-ish actor pick without Math.random dependence at call sites. */
export function pickActor(seed: number): { id: string; name: string } {
  const name = ACTOR_NAMES[seed % ACTOR_NAMES.length];
  return { id: `u_${name.toLowerCase()}`, name };
}

export const EVENT_TEMPLATES: Record<string, (actor: string) => string> = {
  member_join: (a) => `${a} joined the club`,
  match_start: (a) => `A team match started — ${a} is on board 1`,
  poll_open: (a) => `${a} opened a vote poll: "Next team match time?"`,
  announcement: (a) => `${a} posted an announcement`,
};

import type Redis from 'ioredis';
import type { RowDataPacket } from 'mysql2';
import { getPool } from './mysql.js';
import { clubMeta } from './keys.js';
import { config } from './config.js';
import type { Club, ClubKind } from './types.js';

/** The core decision: small clubs push, whale clubs pull. */
export function classifyKind(memberCount: number): ClubKind {
  return memberCount <= config.pushThreshold ? 'push' : 'pull';
}

/**
 * Fast path used on ingest & fanout: club meta from a Redis hash, no DB hit.
 * Seeded once; kept in Redis so the write/fanout paths never touch MySQL for it.
 */
export async function loadClubMeta(redis: Redis, clubId: string): Promise<Club | null> {
  const h = await redis.hgetall(clubMeta(clubId));
  if (!h || !h.name) return null;
  const memberCount = Number(h.memberCount);
  return { id: clubId, name: h.name, memberCount, kind: classifyKind(memberCount) };
}

export async function saveClubMeta(redis: Redis, club: Club): Promise<void> {
  await redis.hset(clubMeta(club.id), { name: club.name, memberCount: String(club.memberCount) });
}

export async function listClubs(): Promise<Club[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT id, name, member_count FROM clubs ORDER BY member_count DESC',
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    memberCount: r.member_count,
    kind: classifyKind(r.member_count),
  }));
}

export async function getUserClubs(userId: string): Promise<Club[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT c.id, c.name, c.member_count
       FROM memberships m JOIN clubs c ON c.id = m.club_id
      WHERE m.user_id = :userId
      ORDER BY c.member_count DESC`,
    { userId },
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    memberCount: r.member_count,
    kind: classifyKind(r.member_count),
  }));
}

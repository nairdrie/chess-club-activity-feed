import { monotonicFactory, decodeTime } from 'ulid';

/**
 * ULIDs are the backbone of ordering + cursors:
 *  - lexicographically sortable == time sortable
 *  - generated once at ingest, reused as the event id, the feed sort key (SK),
 *    and the realtime cursor. One id, one canonical order, everywhere.
 */
const ulid = monotonicFactory();

export function newId(): string {
  return ulid();
}

export function idTime(id: string): number {
  return decodeTime(id);
}

/** cursor is just a ULID; these keep intent readable at call sites */
export type Cursor = string;

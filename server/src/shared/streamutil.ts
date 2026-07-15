import type Redis from 'ioredis';

/**
 * We carry the whole payload as one JSON field `data`. Keeps Streams entries
 * self-describing and maps cleanly to a Kafka record value at scale.
 */
export async function xaddJson(redis: Redis, stream: string, obj: unknown, maxlen = 100000): Promise<string> {
  // Approximate trimming (~) keeps the buffer bounded without blocking the write.
  return redis.xadd(stream, 'MAXLEN', '~', String(maxlen), '*', 'data', JSON.stringify(obj)) as Promise<string>;
}

export type StreamEntry<T> = { id: string; data: T };

/** ioredis returns entries as [id, [k, v, k, v, ...]]. Pull out our `data` field. */
export function parseEntries<T>(raw: [string, string[]][]): StreamEntry<T>[] {
  const out: StreamEntry<T>[] = [];
  for (const [id, fields] of raw) {
    let data: unknown = null;
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === 'data') {
        try {
          data = JSON.parse(fields[i + 1]);
        } catch {
          data = null;
        }
      }
    }
    if (data !== null) out.push({ id, data: data as T });
  }
  return out;
}

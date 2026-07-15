import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from './config.js';
import { log } from './logger.js';
import { idTime } from './ids.js';
import type { FeedItem } from './types.js';

export const TABLE_USER_FEED = 'user_feed';
export const TABLE_CLUB_TIMELINE = 'club_timeline';
export const TABLE_NOTIFY_DEDUPE = 'notify_dedupe';

let raw: DynamoDBClient | null = null;
let doc: DynamoDBDocumentClient | null = null;

export function getDoc(): DynamoDBDocumentClient {
  if (!doc) {
    raw = new DynamoDBClient({
      endpoint: config.dynamo.endpoint,
      region: config.dynamo.region,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    doc = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return doc;
}

export function dayBucket(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------- table lifecycle ----------

async function tableExists(name: string): Promise<boolean> {
  try {
    await getDoc().send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch {
    return false;
  }
}

async function createIfMissing(name: string, ttlAttr?: string): Promise<void> {
  if (await tableExists(name)) return;
  try {
    await getDoc().send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }),
    );
    log.info('created dynamo table', { name });
    if (ttlAttr) {
      // dynamodb-local accepts this; on real Dynamo it enables item expiry
      try {
        await getDoc().send(
          new UpdateTimeToLiveCommand({
            TableName: name,
            TimeToLiveSpecification: { Enabled: true, AttributeName: ttlAttr },
          }),
        );
      } catch (err) {
        log.warn('ttl enable skipped', { name, err: String(err) });
      }
    }
  } catch (err) {
    if (!String(err).includes('ResourceInUseException')) throw err;
  }
}

export async function ensureTables(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await createIfMissing(TABLE_USER_FEED, 'ttl');
      await createIfMissing(TABLE_CLUB_TIMELINE, 'ttl');
      await createIfMissing(TABLE_NOTIFY_DEDUPE, 'ttl');
      log.info('dynamo tables ready');
      return;
    } catch (err) {
      if (i % 10 === 0) log.info('waiting for dynamo...', { err: String(err) });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('dynamo not reachable');
}

// ---------- feed store helpers ----------

const ttlSeconds = () => Math.floor(Date.now() / 1000) + config.feedTtlDays * 86400;

/** PUSH path: materialize a row into a single user's feed. */
export function userFeedRow(userId: string, item: FeedItem) {
  return {
    pk: `USER#${userId}`,
    sk: item.id,
    ...item,
    ttl: ttlSeconds(),
  };
}

/** PULL path: one append to the club's day-bucketed timeline. */
export function clubTimelineRow(item: FeedItem) {
  return {
    pk: `CLUB#${item.clubId}#${dayBucket(item.createdAt)}`,
    sk: item.id,
    ...item,
    ttl: ttlSeconds(),
  };
}

export async function putTimeline(item: FeedItem): Promise<void> {
  await getDoc().send(new PutCommand({ TableName: TABLE_CLUB_TIMELINE, Item: clubTimelineRow(item) }));
}

/** Batched materialize for PUSH clubs (25 items/BatchWrite is the Dynamo cap). */
export async function batchPutUserFeed(userIds: string[], item: FeedItem): Promise<void> {
  await batchPut(TABLE_USER_FEED, userIds.map((uid) => userFeedRow(uid, item)));
}

/** Generic batched PutItem — 25/request (Dynamo cap), chunks written concurrently. */
export async function batchPut(table: string, items: Record<string, unknown>[]): Promise<void> {
  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < items.length; i += 25) chunks.push(items.slice(i, i + 25));
  await Promise.all(
    chunks.map((chunk) =>
      getDoc().send(
        new BatchWriteCommand({
          RequestItems: { [table]: chunk.map((Item) => ({ PutRequest: { Item } })) },
        }),
      ),
    ),
  );
}

interface PageOpts {
  limit: number;
  before?: string; // return items with id < before (older)
  after?: string; // return items with id > after (newer, for backfill)
}

/** Read a single user's materialized feed (PUSH clubs). */
export async function queryUserFeed(userId: string, opts: PageOpts): Promise<FeedItem[]> {
  const { limit, before, after } = opts;
  const forward = !!after; // after => ascending scan then we sort desc for output
  const params: Record<string, unknown> = {
    TableName: TABLE_USER_FEED,
    KeyConditionExpression: after
      ? 'pk = :pk AND sk > :after'
      : before
        ? 'pk = :pk AND sk < :before'
        : 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ...(after ? { ':after': after } : {}), ...(before ? { ':before': before } : {}) },
    ScanIndexForward: forward, // newest-first unless we are backfilling forward
    Limit: limit,
  };
  const res = await getDoc().send(new QueryCommand(params as never));
  return (res.Items ?? []) as FeedItem[];
}

/**
 * PULL path: merge a club's timeline at read time. Walks day buckets newest->oldest
 * until the page is filled (or we run out of recent days).
 */
export async function queryClubTimeline(
  clubId: string,
  opts: PageOpts,
  lookbackDays = 14,
): Promise<FeedItem[]> {
  const { limit, before, after } = opts;
  const out: FeedItem[] = [];
  // Start bucket: from the cursor's day if given, else today.
  const anchor = before ? idTime(before) : after ? Date.now() : Date.now();
  for (let d = 0; d < lookbackDays && out.length < limit; d++) {
    const day = dayBucket(anchor - d * 86400_000);
    const params: Record<string, unknown> = {
      TableName: TABLE_CLUB_TIMELINE,
      KeyConditionExpression: after
        ? 'pk = :pk AND sk > :after'
        : before
          ? 'pk = :pk AND sk < :before'
          : 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `CLUB#${clubId}#${day}`,
        ...(after ? { ':after': after } : {}),
        ...(before ? { ':before': before } : {}),
      },
      ScanIndexForward: !!after,
      Limit: limit - out.length,
    };
    const res = await getDoc().send(new QueryCommand(params as never));
    out.push(...((res.Items ?? []) as FeedItem[]));
    if (after) break; // backfill only needs the current/most-recent bucket window
  }
  return out;
}

/**
 * Exactly-once claim at the sink: conditional PUT keyed by (user, event, channel).
 * Returns true if we won the claim, false if it was already delivered (the dedupe).
 */
export async function claimNotification(
  userId: string,
  eventId: string,
  channel: string,
): Promise<boolean> {
  try {
    await getDoc().send(
      new PutCommand({
        TableName: TABLE_NOTIFY_DEDUPE,
        Item: {
          pk: `USER#${userId}`,
          sk: `${eventId}#${channel}`,
          ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return true;
  } catch (err) {
    if (String(err).includes('ConditionalCheckFailed')) return false;
    throw err;
  }
}

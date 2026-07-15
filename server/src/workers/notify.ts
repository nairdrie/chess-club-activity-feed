import { log } from '../shared/logger.js';
import { makeRedis, waitForRedis } from '../shared/redis.js';
import { runStreamConsumer } from '../shared/consumer.js';
import { STREAM_NOTIFY, STREAM_NOTIFY_DLQ, GROUP_NOTIFY, METRIC } from '../shared/keys.js';
import { bumpMetric } from '../shared/metrics.js';
import { claimNotification, ensureTables } from '../shared/dynamo.js';
import { xaddJson } from '../shared/streamutil.js';
import type { NotificationJob } from '../shared/types.js';

/**
 * NOTIFY WORKER — exactly-once delivery at the sink.
 *
 * Separate consumer group + DLQ. Dedupe via a conditional write on the unique
 * key (user_id, event_id, channel): the winner delivers, everyone else is a
 * no-op (the claim-race fix). Redelivery from at-least-once upstream can never
 * produce a duplicate notification.
 */
const redis = makeRedis('notify');

async function deliver(job: NotificationJob): Promise<void> {
  // Real delivery would call APNs/FCM/SES/websocket here. We simulate success.
  // (in_app could push to a per-user inbox list; kept as a counter for the demo.)
  return;
}

async function handle(job: NotificationJob): Promise<void> {
  const won = await claimNotification(job.userId, job.eventId, job.channel);
  if (!won) {
    bumpMetric(redis, METRIC.notifyDeduped);
    return; // already delivered by a prior/parallel attempt
  }
  try {
    await deliver(job);
    bumpMetric(redis, METRIC.notifyDelivered);
  } catch (err) {
    // Delivery failed after claim — route to DLQ for out-of-band retry.
    await xaddJson(redis, STREAM_NOTIFY_DLQ, { job, err: String(err) });
    bumpMetric(redis, METRIC.notifyDlq);
  }
}

async function main() {
  await waitForRedis(redis);
  await ensureTables();
  log.info('notify worker up');
  await runStreamConsumer<NotificationJob>({
    stream: STREAM_NOTIFY,
    group: GROUP_NOTIFY,
    batch: 256,
    // Concurrent conditional writes; the dedupe is per-key so parallelism is safe.
    handle: async (entries) => {
      await Promise.all(entries.map((e) => handle(e.data)));
    },
  });
}

main().catch((err) => {
  log.error('notify worker crashed', { err: String(err) });
  process.exit(1);
});

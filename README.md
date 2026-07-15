# Chess.com Club Activity Feed — working demo

A runnable, horizontally-scalable implementation of the "Club Activity Feed"
assignment: when something happens in a club (member joins, team match starts,
poll opens, announcement), it shows up near-real-time in every member's feed —
web + mobile — and optionally fires a notification per the member's preferences.

The hard part is scale: **~5k events/sec average, ~20k/sec peak, a single event
fanning out to up to ~500k members**, feeds that feel instant, and notifications
that are **never lost or duplicated**. This repo builds the whole path end-to-end
so the design decisions are *studyable by doing* — including a load generator
whose headline output is a counter that proves **zero loss and zero duplication
under load**.

> This demo is built from technologies I've run in production. Every "local"
> choice has a documented **drop-in swap** for Chess.com scale (Redis Streams→Kafka,
> DynamoDB-local→ScyllaDB). Those annotations are in [§ Swaps at scale](#swaps-at-scale) —
> they're the interview cheat sheet.

---

## TL;DR — run it

```bash
make up                      # build + start everything (first run pulls images)
# open http://localhost:8080  → the chess.com-style UI, click "Simulate event"

make load RATE=8000 SECONDS=30 CLUB=whale   # spike a 500k-member club
# watch the report: buffer depth absorbs the spike, DUPLICATES=0, LOST=0
```

Everything runs in Docker Compose: 3 socket.io pods, 2 API replicas, 4 worker
types, Redis, MySQL, dynamodb-local, and an nginx LB with sticky WebSocket
sessions. Scale any worker: `docker compose up -d --scale fanout=3 --scale drain=2`.

---

## What's in the box

| Layer | Tech (local) | Role |
|---|---|---|
| Frontend | React + TS + Vite | chess.com-style shell, cursor infinite-scroll feed, live socket updates + REST backfill |
| Edge | nginx | LB: round-robin API, **sticky** socket.io, static SPA |
| Realtime | socket.io ×3 pods + `@socket.io/redis-adapter` | one room per `club:{id}`, cross-pod broadcast |
| API | Node + TS + Express (×2) | stateless: ingest, feed reads, preference CRUD, metrics |
| Write buffer | Redis Streams (`stream:ingest`) | O(1) pipeline buffer — **the spike absorber** |
| Durable core | MySQL | domain rows + **transactional outbox** |
| Event log | Redis Streams (`stream:events`) | partitioned by `club_id`; **Kafka at scale** |
| Feed store | dynamodb-local | `user_feed` (push) + `club_timeline` (pull); **ScyllaDB at scale** |
| Notifications | Redis Streams + Dynamo conditional write | separate consumer group, **exactly-once**, DLQ |
| Cache | Redis sorted sets | hot-feed pages, `noeviction` |

---

## Architecture

```mermaid
flowchart TB
  subgraph client[Client]
    UI[React feed UI]
  end
  UI -->|REST /api| LB[nginx LB - sticky WS]
  UI <-->|socket.io| LB

  LB --> API[API replicas x2]
  LB --> RT[socket.io pods x3]

  API -->|XADD O(1), return now| INGEST[(Redis Stream: ingest)]
  INGEST -->|batch| DRAIN[drain worker]
  DRAIN -->|1 tx: domain + outbox| MYSQL[(MySQL: events + outbox)]
  MYSQL -->|poll FOR UPDATE SKIP LOCKED| RELAY[relay worker]
  RELAY -->|publish| EVENTS[(Redis Stream: events - key=club_id)]
  EVENTS --> FANOUT[fanout worker]

  FANOUT -->|push: materialize active members| UFEED[(Dynamo user_feed)]
  FANOUT -->|pull: 1 append| CTL[(Dynamo club_timeline)]
  FANOUT -->|thin payload via redis-emitter| RTADAPT{{redis adapter}}
  RTADAPT --> RT
  RT -->|activity: id+cursor| UI
  FANOUT -->|preference filter| NOTIFY[(Redis Stream: notify)]
  NOTIFY --> NWORKER[notify worker]
  NWORKER -->|conditional write dedupe| DDEDUPE[(Dynamo notify_dedupe)]
  NWORKER -.->|on failure| DLQ[(notify DLQ)]

  API -->|read merge push+pull| UFEED
  API --> CTL
  CACHE[(Redis ZSET hot pages)] --- API
```

### Sequence — "event fired → feed + notification"

```mermaid
sequenceDiagram
  participant C as Client
  participant API
  participant IB as Redis ingest buffer
  participant D as drain
  participant DB as MySQL (events+outbox)
  participant R as relay
  participant EV as Redis events log
  participant F as fanout
  participant FS as Dynamo feed store
  participant RT as socket.io (+adapter)
  participant N as notify

  C->>API: POST /events {clubId,type}
  API->>IB: XADD (O(1))
  API-->>C: 202 {eventId}   # returns immediately, never touches DB
  IB->>D: XREADGROUP (batch)
  D->>DB: BEGIN; INSERT event; INSERT outbox; COMMIT
  D-->>IB: XACK  # only after durable write (no loss window)
  R->>DB: SELECT ... FOR UPDATE SKIP LOCKED
  R->>EV: XADD (publish)
  R->>DB: mark published
  EV->>F: XREADGROUP
  alt club <= threshold (PUSH)
    F->>FS: batch write user_feed (active members only)
  else whale club (PULL)
    F->>FS: 1 append to club_timeline
  end
  F->>RT: emit thin {eventId,cursor} to club room
  RT-->>C: "activity" (id + cursor)
  C->>API: GET /feed?after=cursor  # backfill body via read path
  API-->>C: full items
  F->>N: enqueue notifications (after preference filter)
  N->>FS: conditional write (user,event,channel)
  N-->>N: deliver once / dedupe / DLQ
```

---

## The core decisions (what to look at)

### 1. Whale-club path first — push vs pull
The easy case is **push**: materialize a copy of the event into every member's
`user_feed`. That's fine for small clubs but catastrophic for a 500k-member whale
(one event → 500k writes). So the fanout worker branches on club size
(`PUSH_THRESHOLD`, default 5k):

- **PUSH** (`memberCount <= threshold`): materialize per-user rows in `user_feed`.
  Reads are a single-partition query. → `server/src/workers/fanout.ts`
- **PULL** (whale): **one** append to `club_timeline` (day-bucketed). Readers
  **merge the timeline at read time**. → `server/src/api/feed.ts` (`getFeedPage`)

The read path unifies both into one ULID-sorted page and tags each row `via: push`
/ `via: pull` — the UI shows the provenance pill so you can *see* which path served
each row.

### 2. Only touch active users — the highest-ROI optimization
Even push, and all notifications, only fan out to **users active in the last N
days** — a single Redis set intersection (`SINTER club:{id}:members active:users`).
For a whale this collapses 500k → the active few. See `activeMembersOf()` in
`fanout.ts`. (`ACTIVE_SAMPLE` sizes this set in the demo so a laptop can run a
"500k" club; the *code path* is exactly the production one.)

### 3. The spike absorber — never touch the DB on the request path
`POST /events` does an O(1) `XADD` to `stream:ingest` and returns immediately
(club metadata comes from a Redis hash, not MySQL). The **drain worker** persists
asynchronously in batches. Under a 20k/sec peak the request path stays flat while
the buffer depth rises and drains — visible live as `bufferDepth` in
`/api/metrics` and the load report. → `server/src/api/index.ts`, `workers/drain.ts`

### 4. No-loss guarantee — transactional outbox + ordered ACK
Two independent safety nets:
- The **drain worker writes the domain row and the outbox row in ONE MySQL
  transaction**, then ACKs the buffer entry **only after commit** ("write DB
  first, then remove from buffer" — the fix to the loss window). A crash mid-batch
  leaves entries pending; they're redelivered (`XAUTOCLAIM`) and re-applied
  idempotently (`INSERT IGNORE`).
- The **relay worker** polls the outbox with `FOR UPDATE SKIP LOCKED` (many
  replicas, zero double-claim), publishes to the event log, then marks published.

### 5. Exactly-once notifications
- **Preference filter before fanout** (cheapest reducer): muted clubs and
  disabled channels are dropped before anything is enqueued. → `shared/prefs.ts`
- **Dedupe at the sink**: the notify worker does a **conditional write** on the
  unique key `(user_id, event_id, channel)` in `notify_dedupe`. The winner
  delivers; every redelivery is a no-op. This is the claim-race fix — redelivery
  from at-least-once upstream can never produce a duplicate notification.
- **Separate consumer group + DLQ** so notification delivery failures never block
  the feed path.

### 6. Realtime — thin payload, client backfills
Fanout pushes only `{eventId, cursor, clubId, createdAt}` to the club room (via
`@socket.io/redis-emitter`, so a *worker* can broadcast across all pods through
the same redis adapter). The client inserts by cursor and **backfills the body
through the REST read path** (`GET /feed?after=cursor`). On reconnect it does the
same `after`-cursor backfill, then resumes the stream — no gaps, no full objects
on the wire.

---

## Guarantees, made observable

The load generator (`server/src/loadgen/index.ts`) is both a **producer** (fires
`RATE` events/sec at a club) and a **consumer** (a socket.io client in the club
room). Because it sees every event it fired come back over the realtime path, it
computes the guarantees with no trust required:

```
── GUARANTEES ────────────────────────────────
DUPLICATES         0  ✅ (zero duplication)
LOST               0  ✅ (zero loss)
```

It also prints buffer depth, drain rate, end-to-end latency (`now − createdAt`),
and the server-side counters (`notify deduped` proves the exactly-once path is
actually firing under redelivery). The same counters render live in the UI's
"Live guarantees" widget.

```bash
make load RATE=8000 SECONDS=30 CLUB=whale   # whale = PULL path
make load RATE=3000 SECONDS=20 CLUB=small   # small = PUSH path
```

---

<a name="swaps-at-scale"></a>
## Swaps at scale (the cheat sheet)

Everything here is deliberately swappable. The point of the demo is that the
*shape* is production-correct; only the managed backing service changes.

- **Redis Streams → Kafka.** `stream:ingest`, `stream:events`, `stream:notify` are
  consumer-group logs with `XACK`/`XAUTOCLAIM` — the exact semantics of Kafka
  consumer groups + rebalancing. Partition key is `club_id` (ordering per club).
  The **transactional outbox keeps this swappable**: nothing publishes to the log
  except the relay, so replacing the relay's `XADD` with a Kafka produce (or
  Debezium CDC off the outbox table) is a localized change. Redis Streams is the
  right call up to a point; Kafka is the drop-in when throughput/retention/replay
  outgrow a single Redis.
- **dynamodb-local → ScyllaDB (or DynamoDB).** `user_feed` (PK `USER#id`, SK
  ULID, TTL, capped) and `club_timeline` (PK `CLUB#id#day`, SK ULID) map 1:1 to
  Scylla wide-partition tables. Key schema, day-bucketing, and TTL are identical;
  only the driver changes. Scylla is Chess.com's fit for the write volume + p99.
- **MySQL → same MySQL, bigger.** The durable core + outbox is intentionally
  boring and relational. Shard by `club_id` if the write path outgrows one
  primary; the outbox pattern is shard-local.
- **Redis (single) → Redis Cluster, with the dedupe/idempotency instance on
  `noeviction`.** LRU eviction on the dedupe keys would let a redelivery slip
  through as a duplicate, so that instance must never evict.
- **Docker Compose → Kubernetes.** Each compose service is a Deployment; API and
  workers get an HPA (queue-depth / CPU); the LB becomes an ingress with sticky
  sessions; Redis/MySQL/Scylla are managed/operated.

---

## API sketch

REST (`/api`, behind the LB):

| Method | Path | Purpose |
|---|---|---|
| POST | `/events` | ingest `{clubId,type,text?}` → `202 {eventId}` (buffered, returns now) |
| GET | `/feed?userId&limit&before&after` | push/pull merged page → `{items, nextCursor, hasMore}` |
| GET | `/clubs` | `[{id,name,memberCount,kind}]` |
| GET | `/me` | current demo user + clubIds |
| GET/PUT | `/preferences` | per-user channel prefs + muted clubs |
| GET | `/metrics` | live counters + buffer depth (the observability surface) |

Realtime (socket.io, same origin): client emits `join {userId, clubIds}`; server
emits `activity {eventId, cursor, clubId, type, createdAt}` (thin).

`FeedItem = { id(ULID/cursor), eventId, clubId, clubName, type, actorId, actorName,
text, createdAt, via: 'push'|'pull' }`

---

## Frontend note (all-stack)

The client uses **WebSockets** (socket.io) for liveness, not polling — a poll loop
at this fanout would hammer the read path, and SSE gives up the cheap client→server
`join`. The socket carries only a **thin cursor**; the client **backfills the body
through the REST read path**, so the same cache/query serves both first-load and
live updates (one code path to keep consistent). **Reconnection/backfill**: on
connect *and* reconnect the client calls `GET /feed?after=<newestCursor>` before
resuming the stream, so a dropped socket never drops an event. **UI consistency**:
ULID cursors give a single global order; new items insert by cursor (dedup by id),
and infinite scroll pages backward with `before`. If the user has scrolled down,
live items queue behind a "N new" pill instead of yanking the viewport.

## AI-agent implementation note

I'd lean on agents for the **mechanical breadth**: scaffolding the shared
contracts (types, Redis keys, table schemas) once and generating the services
against them, the React shell, the compose wiring, and the load generator. I would
*not* hand them the **correctness-critical seams** unsupervised — the ACK-after-commit
ordering in drain, the `FOR UPDATE SKIP LOCKED` relay, and the conditional-write
dedupe are where the design earns its keep, so those get written deliberately and
guarded by the observable invariant. The way you keep quality under control is to
make correctness **measurable**: a load generator that fails CI if duplicates or
lost events are ever non-zero is worth more than any amount of code review, because
it holds the guarantee no matter what the agent refactors underneath it.

---

## Layout

```
server/                Node+TS — one image, many roles (tsx, no build step)
  src/shared/          config, types, keys, redis/mysql/dynamo clients, ids, prefs, consumer loop
  src/api/             Express: ingest, feed (push/pull merge), prefs, metrics
  src/workers/         drain · relay · fanout · notify
  src/realtime/        socket.io pod (+ redis adapter)
  src/loadgen/         producer+consumer load test (prints the guarantees)
  src/seed.ts          clubs, memberships, active sets, feed history
web/                   React+TS+Vite chess.com-style UI
infra/nginx/lb.conf    edge LB (sticky WS)
docker-compose.yml     3 rt pods · 2 api · workers · redis · mysql · dynamodb · lb
Makefile               up / down / load / scale / logs
```

## Tuning knobs (`.env`)

`PUSH_THRESHOLD` (push/pull cutoff) · `ACTIVE_SAMPLE` (active-set size) ·
`WHALE_MEMBERS` · `DRAIN_BATCH` / `RELAY_BATCH` / `RELAY_POLL_MS` ·
`LOAD_RATE` / `LOAD_SECONDS` / `LOAD_CLUB`.

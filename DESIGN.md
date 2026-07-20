# Club Activity Feed — System Design (one page)

> The one-page deliverable. A runnable implementation of this design lives in
> this repo (`README.md`); every box below is built and load-tested.

**Design in one breath.** Events are accepted onto a Redis Streams **ingest buffer**
in O(1) and the request returns immediately (never touches the DB on the write
path — the spike absorber). A **drain** worker persists each event with its
**outbox row in one MySQL transaction**, ACKing the buffer only after commit
(no loss window). A **relay** polls the outbox (`FOR UPDATE SKIP LOCKED`) and
publishes to the event log. A **fanout** worker then always appends the event to
a day-bucketed **`club_timeline`** — the complete, authoritative per-club log —
and, for **small (push) clubs**, *additionally* materializes it into the
**`user_feed`** of members **active in the last N days** (a Redis set
intersection) as a hot read cache. Whale (pull) clubs and inactive members are
never materialized; the read path **merges each club's timeline** to reconstruct
them, so no member ever misses an event (this also makes threshold-crossing
safe). `user_feed` is thus a rebuildable cache; `club_timeline`/`events` are the
truth. Fanout also pushes a **thin realtime payload** (id + cursor) to the club's
socket room and enqueues **preference-filtered** notifications, deduplicated
exactly-once at the sink by a conditional write on `(user, event, channel)`.

Chosen from tech I've run in production; each has a documented scale swap:
**Redis Streams → Kafka** (outbox keeps it a localized swap), **DynamoDB →
ScyllaDB** (identical key schema), **Compose → k8s Deployments + HPA**.

## Component diagram

```mermaid
flowchart TB
  UI[Web + mobile client] -->|REST| LB[LB - sticky WS]
  UI <-->|socket.io| LB
  LB --> API[API replicas]
  LB --> RT[socket.io pods x3 + redis adapter]
  API -->|XADD, returns now| INGEST[(Redis Stream: ingest)]
  INGEST -->|batch| DRAIN[drain worker]
  DRAIN -->|1 tx: domain + outbox| MYSQL[(MySQL: events + outbox)]
  MYSQL -->|poll FOR UPDATE SKIP LOCKED| RELAY[relay worker]
  RELAY -->|publish, key=club_id| EVENTS[(Redis Stream: events -- Kafka at scale)]
  EVENTS --> FANOUT[fanout worker]
  FANOUT -->|always: 1 append per club| CTL[(club_timeline -- authoritative log)]
  FANOUT -->|push clubs: materialize active members| UFEED[(user_feed -- active cache)]
  FANOUT -->|thin payload| RT
  RT -->|activity id+cursor| UI
  FANOUT -->|coalesce: HINCRBY counter| DIGEST[(Redis: per-user digest counters)]
  FANOUT -->|window open: ZADD due-time| DUE[(Redis: digest due-set -- ZSET)]
  FANOUT -.->|high-priority: immediate| NOTIFY[(Redis Stream: notify)]
  DUE -->|pop due <= now: who| SCHED[digest scheduler]
  DIGEST -->|HGETALL then reset: what| SCHED
  SCHED -->|N new in club summary| NOTIFY
  NOTIFY --> NW[notify worker]
  NW -->|conditional-write dedupe| DDQ[(notify_dedupe)]
  NW -.->|on failure| DLQ[(DLQ)]
  API -->|read: fast path| UFEED
  API -->|read: merge for completeness| CTL
  CACHE[(Redis ZSET hot pages)] --- API
```

## Sequence — event fired → fanned out → feed + notification

```mermaid
sequenceDiagram
  participant C as Client
  participant API
  participant IB as Redis ingest
  participant D as drain
  participant DB as MySQL
  participant R as relay
  participant EV as event log
  participant F as fanout
  participant FS as feed store
  participant RT as socket.io
  participant DG as digest counters
  participant SCH as digest sched
  participant N as notify
  C->>API: POST /events {clubId,type}
  API->>IB: XADD
  API-->>C: 202 {eventId}
  IB->>D: XREADGROUP batch
  D->>DB: tx -- INSERT event + outbox, COMMIT
  D-->>IB: XACK (only after commit)
  R->>DB: SELECT ... FOR UPDATE SKIP LOCKED
  R->>EV: publish
  EV->>F: XREADGROUP
  F->>FS: 1 append club_timeline (always -- authoritative log)
  opt club <= threshold (PUSH)
    F->>FS: materialize user_feed (active members -- hot cache)
  end
  F->>RT: emit thin {eventId,cursor}
  RT-->>C: activity
  C->>API: GET /feed?after=cursor
  API-->>C: user_feed fast path + club_timeline merge (complete)
  F->>DG: preference filter, then coalesce -- HINCRBY digest per user+club
  Note over DG: many events collapse to one counter per user/club/window
  SCH->>DG: each window -- read and reset counters
  SCH->>N: one digest -- "N new in {club}"
  N->>FS: conditional write (user, club, window)
  N-->>N: deliver once / dedupe / DLQ
```

## Notification fan-out & digesting

Notifications target **preference-enabled members** (not just active users — push/email
exist to reach people who are away), which for a busy whale is a huge fan-out. Two
reducers keep it sane. **Preference filter** (in fanout) drops muted clubs / disabled
channels before anything is enqueued. **Digesting** then collapses volume by *time* rather
than by dropping recipients: instead of one notification per event, fanout does an O(1)
`HINCRBY digest:{user}:{club}` into a per-user counter — and, when that opens a new window
(the `HINCRBY` returns 1), `ZADD digest:due <now+window> {user}` to register a flush
deadline. A **digest scheduler** pops the **due-set** (`ZRANGEBYSCORE … <= now`) to find
exactly who's ready — never scanning all users — reads their counters (`HGETALL`), emits a
single summary — *"50 new activities in Team USA"* — then clears both. Volume becomes
**users × windows**, not **users × events**. High-priority
event types (e.g. a match start) can bypass the digest for immediate delivery. Each digest
is keyed `(user, club, window)`, so the same exactly-once conditional-write dedupe + DLQ
applies — a window is delivered once or not at all. In-app is a live badge count off the
same counter; push/email are the digested channels.

## API sketch

**HTTP (OpenAPI 3, abbreviated):**

```yaml
paths:
  /events:               # ingest — buffered, returns immediately
    post:
      requestBody: { clubId: string, type: EventType, text?: string }
      responses: { 202: { accepted: true, eventId: ulid } }
  /feed:                 # push/pull merged, cursor pagination
    get:
      parameters: [userId, limit, before?, after?]   # before=older, after=backfill
      responses: { 200: { items: FeedItem[], nextCursor: ulid|null, hasMore: bool } }
  /preferences:          # per-user channel prefs
    get:  { 200: Preferences }
    put:  { requestBody: Preferences, 200: Preferences }
components:
  EventType: [member_join, match_start, poll_open, announcement]
  FeedItem:     { id: ulid, eventId: ulid, clubId, clubName, type: EventType,
                  actorId, actorName, text, createdAt: int64, via: [push,pull] }
  Preferences:  { userId, inApp: bool, email: bool, push: bool, mutedClubs: string[] }
```

**Realtime (socket.io):** client `join {userId, clubIds[]}` → server
`activity {eventId, cursor, clubId, type, createdAt}` (thin; client backfills body via `/feed?after=`).

**Bus message (Protobuf, the event-log record — Kafka-native at scale):**

```proto
message ActivityEvent {
  string id = 1;            // ULID: ordering + cursor + feed sort key
  string club_id = 2;       // partition key
  EventType type = 3;
  string actor_id = 4; string actor_name = 5;
  string club_name = 6; string text = 7;
  int64  created_at = 8;    // epoch ms, stamped at ingest
  int32  member_count = 9;  // snapshot -> fanout decides push/pull without a DB hit
}
```

## Frontend note (all-stack)

**WebSockets**, not polling — a poll loop at this fanout would hammer the read
path, and SSE loses the cheap client→server `join`. The socket carries only a
**thin cursor**; the client **backfills the body through the REST read path**, so
one query serves both first-load and live updates. **Reconnection/backfill:** on
connect *and* reconnect the client calls `GET /feed?after=<newestCursor>` before
resuming, so a dropped socket never drops an event. **Consistency:** ULID cursors
give one global order; items insert by cursor (dedup by id), infinite scroll pages
backward with `before`; if scrolled down, live items queue behind a "N new" pill.
Same REST+WS contract serves web and mobile; native push maps to the `push` channel.

## AI-agent implementation

Lean on agents for **mechanical breadth**: scaffolding shared contracts (types,
Redis keys, table schemas) once and generating the services, the React shell, the
Compose wiring, and the load generator against them. Don't hand them the
**correctness-critical seams** unsupervised — ACK-after-commit in drain, the
`SKIP LOCKED` relay, the conditional-write dedupe — write those deliberately.
Keep quality under control by making correctness **measurable**: a load generator
that fails if duplicates or lost events are ever non-zero holds the guarantee no
matter what the agent refactors underneath.

## Guarantees & scale

Exactly-once (idempotent sinks: ULID-keyed feed writes + conditional-write notify
dedupe + an emit-once `SET NX` guard so a reprocessed event never double-fires the
realtime frame) and no-loss (transactional outbox + ACK-after-commit) are **proven
by a load generator that reports duplicates and lost events — both 0**. Per-club
ordering via ULID + `club_id` partition. The 5k/s-avg, 20k/s-peak targets are met
by design through partition-by-`club_id` + horizontally scaled workers/pods
(Kafka + Scylla at scale); the demo proves the *mechanism and the guarantees* hold
under load and that latency drops as workers are added.

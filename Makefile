# Convenience wrapper around docker compose for the demo.
# Load profile defaults to the spec: ~5k events/sec average, ~20k/sec peak.
RATE    ?= 5000
PEAK    ?= 20000
SECONDS ?= 30
CLUB    ?= whale
PEAK_AT ?=

# Per-worker replica counts (override on the CLI, e.g. `make up FANOUT=4`).
# Fanout is the dominant stage under the whale load (the stage-lag gauges show
# fanout lag ~= total e2e latency, drain lag ~= 0). BUT on a single laptop, scaling
# it too far BACKFIRES: 3 was measured best; at 6 the shared single Redis saturates
# on digest HINCRBY/ZADD and starves drain (also Redis-bound), so BOTH lags blow up
# and latency triples. That's the single-node ceiling — the tell is drain lag rising
# alongside fanout. Managed Dynamo / a Redis cluster remove it at real scale; on a
# laptop, keep fanout ~= (cores - infra) and watch the gauges when you tune.
FANOUT ?= 3
DRAIN  ?= 2
NOTIFY ?= 3
DIGEST ?= 2
SCALE_FLAGS = --scale fanout=$(FANOUT) --scale drain=$(DRAIN) --scale notify=$(NOTIFY) --scale digest=$(DIGEST)

.PHONY: up down logs ps seed load rebuild clean reset scale health lb-refresh diag

## Bring the whole stack up at the demo's default scale (builds on first run).
up:
	docker compose up -d --build --remove-orphans $(SCALE_FLAGS)
	$(MAKE) --no-print-directory lb-refresh
	@echo "\n➡  UI:       http://localhost:8080"
	@echo "➡  Metrics:  http://localhost:8080/api/metrics"
	@echo "➡  Load:     make load            # 5k avg / 20k peak, 30s, whale"
	@echo "➡  Scale:    fanout=$(FANOUT) drain=$(DRAIN) notify=$(NOTIFY) digest=$(DIGEST)  (override: make up FANOUT=8)\n"

## Recreate ONLY the nginx LB so it re-resolves backend container IPs via Docker
## DNS. Open-source nginx resolves `upstream { server api1; ... }` names once at
## startup and caches the IPs; a `--build`/scale recreates api/rt with NEW IPs,
## so a stale LB round-robins /api to whatever now holds the old IP (e.g. an rt
## pod, which 404s everything but /health). Refreshing the LB last fixes it.
lb-refresh:
	docker compose up -d --force-recreate --no-deps lb

## Stop everything (keep data volume).
down:
	docker compose down

## Stop and wipe volumes (fresh MySQL).
clean:
	docker compose down -v

## Full clean-slate restart: wipe MySQL volume + drop the (in-memory) Redis and
## DynamoDB state, rebuild images, and re-run the seed. Use this before a fresh
## load test so counters/streams/digest state all start from zero.
##   make reset            # keep current images if unchanged
##   make reset ARGS=--build   # force an image rebuild too
reset:
	docker compose down -v --remove-orphans
	docker compose up -d --build --remove-orphans $(SCALE_FLAGS)
	$(MAKE) --no-print-directory lb-refresh
	@echo "\n✔ clean stack up (fanout=$(FANOUT) drain=$(DRAIN) notify=$(NOTIFY) digest=$(DIGEST)) and re-seeded."
	@echo "➡  UI:       http://localhost:8080"
	@echo "➡  Load:     make load            # 5k avg / 20k peak, 30s, whale\n"

## Tail logs (make logs S=fanout for one service).
logs:
	docker compose logs -f $(S)

ps:
	docker compose ps

## Re-run the seed job.
seed:
	docker compose run --rm seed

## Fire the load generator and print the guarantees report.
## Defaults to the spec profile (5k avg, 20k peak, 30s, whale). Override any:
##   make load RATE=5000 PEAK=20000 SECONDS=30 CLUB=whale PEAK_AT=15
load:
	docker compose build loadgen
	LOAD_RATE=$(RATE) LOAD_PEAK=$(PEAK) LOAD_SECONDS=$(SECONDS) LOAD_CLUB=$(CLUB) LOAD_PEAK_AT=$(PEAK_AT) \
		docker compose run --rm loadgen

## Re-apply the default worker scale (or edit SCALE_FLAGS above).
scale:
	docker compose up -d $(SCALE_FLAGS)
	$(MAKE) --no-print-directory lb-refresh

## Quick health probe through the LB.
health:
	@curl -s http://localhost:8080/api/health | sed 's/^/api: /'
	@echo ""

## Diagnose LB → backend routing if /api/* is flaky: what `api` resolves to,
## each replica's direct health, and a probe through the LB (expect JSON, not 404).
diag:
	@docker compose ps
	@echo "\n── LB resolves 'api' (expect the 2 API IPs) and 'rt' (expect the 3 rt IPs) ──"
	@docker compose exec -T lb nslookup api 2>/dev/null || true
	@docker compose exec -T lb nslookup rt 2>/dev/null || true
	@echo "── API replicas, probed directly (expect {\"ok\":true...}) ──"
	@docker compose exec -T lb sh -c 'for h in api1 api2; do printf "%s: " $$h; wget -qO- http://$$h:8080/health || echo FAIL; echo; done' || true
	@echo "── /api/health through the LB (expect JSON, not 404) ──"
	@docker compose exec -T lb sh -c 'wget -qO- http://localhost/api/health; echo' || true

rebuild:
	docker compose build

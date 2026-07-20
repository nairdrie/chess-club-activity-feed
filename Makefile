# Convenience wrapper around docker compose for the demo.
# Load profile defaults to the spec: ~5k events/sec average, ~20k/sec peak.
RATE    ?= 5000
PEAK    ?= 20000
SECONDS ?= 30
CLUB    ?= whale
PEAK_AT ?=

# Default worker fan-out for the demo (see README "Scaling the demo"): the
# single-node bottleneck is fanout + notify, so we run those wide by default.
SCALE_FLAGS = --scale fanout=3 --scale drain=2 --scale notify=3 --scale digest=2

.PHONY: up down logs ps seed load rebuild clean reset scale health

## Bring the whole stack up at the demo's default scale (builds on first run).
up:
	docker compose up -d --build $(SCALE_FLAGS)
	@echo "\n➡  UI:       http://localhost:8080"
	@echo "➡  Metrics:  http://localhost:8080/api/metrics"
	@echo "➡  Load:     make load            # 5k avg / 20k peak, 30s, whale"
	@echo "➡  Scale:    workers default to fanout=3 drain=2 notify=3 digest=2\n"

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
	docker compose down -v
	docker compose up -d --build $(SCALE_FLAGS)
	@echo "\n✔ clean stack up (fanout=3 drain=2 notify=3 digest=2) and re-seeded."
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
	LOAD_RATE=$(RATE) LOAD_PEAK=$(PEAK) LOAD_SECONDS=$(SECONDS) LOAD_CLUB=$(CLUB) LOAD_PEAK_AT=$(PEAK_AT) \
		docker compose run --rm loadgen

## Re-apply the default worker scale (or edit SCALE_FLAGS above).
scale:
	docker compose up -d $(SCALE_FLAGS)

## Quick health probe through the LB.
health:
	@curl -s http://localhost:8080/api/health | sed 's/^/api: /'
	@echo ""

rebuild:
	docker compose build

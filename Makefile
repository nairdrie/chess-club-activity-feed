# Convenience wrapper around docker compose for the demo.
RATE    ?= 2000
SECONDS ?= 20
CLUB    ?= whale

.PHONY: up down logs ps seed load rebuild clean scale health

## Bring the whole stack up (builds images on first run).
up:
	docker compose up -d --build
	@echo "\n➡  UI:       http://localhost:8080"
	@echo "➡  Metrics:  http://localhost:8080/api/metrics"
	@echo "➡  Load:     make load RATE=5000 SECONDS=30 CLUB=whale\n"

## Stop everything (keep data volume).
down:
	docker compose down

## Stop and wipe volumes (fresh MySQL).
clean:
	docker compose down -v

## Tail logs (make logs S=fanout for one service).
logs:
	docker compose logs -f $(S)

ps:
	docker compose ps

## Re-run the seed job.
seed:
	docker compose run --rm seed

## Fire the load generator and print the guarantees report.
##   make load RATE=8000 SECONDS=30 CLUB=whale
load:
	LOAD_RATE=$(RATE) LOAD_SECONDS=$(SECONDS) LOAD_CLUB=$(CLUB) \
		docker compose run --rm loadgen

## Example: scale the fanout + drain workers.
scale:
	docker compose up -d --scale fanout=3 --scale drain=2 --scale notify=2

## Quick health probe through the LB.
health:
	@curl -s http://localhost:8080/api/health | sed 's/^/api: /'
	@echo ""

rebuild:
	docker compose build

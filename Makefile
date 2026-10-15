# Plain make, no tool manager. Needs: go, node (dev tools only), buf + protoc-gen-go +
# protoc-gen-connect-go (only to change proto/).
VERSION ?= $(shell git describe --tags --match 'v*' --always --dirty 2>/dev/null || echo dev)

.PHONY: build run run-single test gen smoke e2e screenshots check

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o scoreboard ./cmd/scoreboard

run: build        # several offices with secret links, on :8080
	./scoreboard serve --db dev.db

run-single: build # one office, no links
	./scoreboard serve --db dev.db --mode single

test:
	go test ./...
	npm test

gen:              # regenerate gen/ after editing proto/
	buf lint
	buf generate

smoke: build      # end-to-end check against a throwaway server
	@rm -f /tmp/scoreboard-smoke.db*
	@./scoreboard serve --db /tmp/scoreboard-smoke.db --listen :8791 --admin-listen "" --join-limit 0 --write-limit 0 & \
	  pid=$$!; sleep 1; node scripts/smoke.js http://localhost:8791; code=$$?; kill $$pid; exit $$code

e2e: build        # drives Chromium through both modes (CHROME=/path to pick a browser)
	npm run e2e

screenshots: build # README images in docs/screenshots/ (commit them with UI changes)
	npm run screenshots

check:            # what CI runs (plus `make smoke e2e`)
	gofmt -l cmd internal gen web | (! grep .)
	go vet ./...
	buf lint
	go test -race ./...
	npm test

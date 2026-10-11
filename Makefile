# Plain make, no tool manager. Needs: go, node (dev tools only), buf + protoc-gen-go +
# protoc-gen-connect-go (only to change proto/).
VERSION ?= $(shell git describe --tags --match 'v*' --always --dirty 2>/dev/null || echo dev)

.PHONY: build run run-single test gen smoke check

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

check:            # what CI runs
	gofmt -l cmd internal gen web | (! grep .)
	go vet ./...
	buf lint
	go test -race ./...
	npm test

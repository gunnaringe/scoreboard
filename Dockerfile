# syntax=docker/dockerfile:1
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /scoreboard ./cmd/scoreboard \
 && mkdir /data

# One static binary, no shell: administer a running container with
#   docker exec <container> /scoreboard admin <command>
FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.title="Scoreboard" \
      org.opencontainers.image.description="Game scores with fair team ratings, self-hosted" \
      org.opencontainers.image.source="https://github.com/gunnaringe/scoreboard" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /scoreboard /scoreboard
COPY --from=build --chown=nonroot:nonroot /data /data
ENV SCOREBOARD_DB=/data/scoreboard.db \
    SCOREBOARD_LISTEN=:8080 \
    SCOREBOARD_ADMIN_LISTEN=127.0.0.1:8081
VOLUME /data
EXPOSE 8080
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/scoreboard", "healthcheck"]
ENTRYPOINT ["/scoreboard"]
CMD ["serve"]

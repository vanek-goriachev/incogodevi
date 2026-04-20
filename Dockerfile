# syntax=docker/dockerfile:1.7
#
# Multi-stage, multi-arch image for the Go Dependencies Visualizer.
#
# Stage layout (see architecture.md ADR-04, §9 Deployment):
#   1. node:24-alpine      — build the React/Vite SPA into /web/dist.
#   2. golang:1.26-alpine  — copy dist into the embed tree and produce a
#                            statically-linked, trimmed server binary.
#   3. distroless/static   — minimal nonroot runtime that just runs /server.
#
# Pinned base images are reviewed before each release per architecture.md §11.
# Build with:
#   docker build -t go-viz:dev .
# Multi-arch build with:
#   docker buildx build --platform linux/amd64,linux/arm64 -t go-viz:multiarch .

# ---------- Stage 1: frontend bundle ------------------------------------------
FROM node:24-alpine AS frontend

WORKDIR /web

# Install dependencies first so changes under src/ do not bust the npm cache.
# --ignore-scripts keeps third-party post-install scripts from running during
# the image build (defence in depth; we have no native deps). npm install
# (rather than npm ci) handles platform-specific optionalDependencies that
# may not be present in a lockfile generated on a different host arch — the
# same approach the CI workflow uses. --prefer-offline + --fund=false keep
# network noise low.
COPY web/package.json web/package-lock.json ./
RUN npm install --ignore-scripts --no-audit --no-fund --prefer-offline

# Copy the rest of the frontend source and build the production bundle.
# Vite places the output in /web/dist by default. The .browserslistrc and
# tsconfig.json are part of the source tree and copied via the wildcard.
COPY web/ ./
RUN npm run build

# ---------- Stage 2: backend binary -------------------------------------------
FROM golang:1.26-alpine AS backend

# git is occasionally needed by `go mod download` for VCS-resolved replacements.
RUN apk add --no-cache git ca-certificates

WORKDIR /src

# Cache modules in their own layer.
COPY server/go.mod server/go.sum ./
RUN go mod download

# Copy the rest of the server source.
COPY server/ ./

# Drop the dev placeholder and replace it with the freshly built SPA. The
# embed.FS in server/internal/web/embed.go uses //go:embed all:dist, so the
# whole directory ends up baked into the binary.
RUN rm -rf ./internal/web/dist
COPY --from=frontend /web/dist ./internal/web/dist

# Build a static, stripped binary with reproducible paths. VERSION is an
# optional build arg; when unset the source-level default ("0.1.0-dev") wins.
ARG VERSION=0.1.0-dev
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 \
    GOOS=${TARGETOS} \
    GOARCH=${TARGETARCH}
RUN go build \
        -trimpath \
        -ldflags "-s -w -X main.version=${VERSION}" \
        -o /out/server \
        ./cmd/server

# ---------- Stage 3: runtime --------------------------------------------------
# distroless/static-debian12:nonroot is the default tag as of 2026-04-19
# (see architecture.md ADR-04). It ships ca-certificates, /tmp and a
# nonroot user (uid/gid 65532) — exactly what we need for a CGO-disabled
# Go binary that writes its disk cache under /tmp.
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

COPY --from=backend /out/server /server

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]

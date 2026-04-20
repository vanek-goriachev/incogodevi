# Top-level Makefile for the Go Dependencies Visualizer monorepo.
# All Go targets shell out into ./server so contributors can stay at repo root.

SERVER_DIR := server
BIN        := $(SERVER_DIR)/bin/server

# Container image coordinates. Override on the command line:
#   make docker-build GH_USER=acme VERSION=v1.2.3
GH_USER  ?= vanek-goriachev
IMAGE    ?= ghcr.io/$(GH_USER)/go-viz
VERSION  ?= dev
PLATFORMS ?= linux/amd64,linux/arm64

.PHONY: all lint test build run tidy clean help \
        docker-build docker-build-local docker-run

all: lint test build

## lint: run golangci-lint over the server module
lint:
	cd $(SERVER_DIR) && golangci-lint run ./...

## test: run unit tests with race detector and coverage profile
test:
	cd $(SERVER_DIR) && go test -race -coverprofile=coverage.out ./...

## build: compile the server binary into server/bin/server
build:
	cd $(SERVER_DIR) && CGO_ENABLED=0 go build -o bin/server ./cmd/server

## run: start the freshly built server binary in the foreground
run: build
	./$(BIN)

## tidy: synchronise go.mod / go.sum
tidy:
	cd $(SERVER_DIR) && go mod tidy

## clean: remove build artefacts
clean:
	rm -rf $(SERVER_DIR)/bin $(SERVER_DIR)/coverage.out

## docker-build: multi-arch image via buildx (no --load, no --push by default)
docker-build:
	docker buildx build \
		--platform $(PLATFORMS) \
		--build-arg VERSION=$(VERSION) \
		-t $(IMAGE):$(VERSION) \
		.

## docker-build-local: single-arch image for the current host (loaded into docker)
docker-build-local:
	docker build \
		--build-arg VERSION=$(VERSION) \
		-t $(IMAGE):$(VERSION) \
		-t go-viz:dev \
		.

## docker-run: run the locally built image on port 8080
docker-run:
	docker run --rm -p 8080:8080 $(IMAGE):$(VERSION)

## help: list available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## //'

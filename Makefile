# Top-level Makefile for the Go Dependencies Visualizer monorepo.
# All Go targets shell out into ./server so contributors can stay at repo root.

SERVER_DIR := server
BIN        := $(SERVER_DIR)/bin/server

.PHONY: all lint test build run tidy clean help

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

## help: list available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## //'

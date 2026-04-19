// Command server starts the Go Dependencies Visualizer HTTP backend.
//
// At this stage the binary exposes only the health endpoint defined in
// docs/api-contract.md §7. Real analysis endpoints land in later tasks.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// version is the build-time version string. Bumped together with releases.
const version = "0.1.0-dev"

// Default configuration. Overridable via environment.
const (
	defaultAddr     = ":8080"
	defaultLogLevel = "info"

	readHeaderTimeout = 10 * time.Second
	idleTimeout       = 120 * time.Second
	shutdownTimeout   = 10 * time.Second
)

func main() {
	cfg := loadConfig()
	logger := newLogger(cfg.logLevel)
	slog.SetDefault(logger)

	startedAt := time.Now()
	mux := newMux(startedAt)

	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
		// WriteTimeout is intentionally zero: SSE responses stream for the
		// entire lifetime of an analysis (see architecture.md §3.1, ADR-03).
		WriteTimeout: 0,
		IdleTimeout:  idleTimeout,
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("server starting", slog.String("addr", srv.Addr), slog.String("version", version))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case <-rootCtx.Done():
		logger.Info("server shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("graceful shutdown failed", slog.String("error", err.Error()))
			os.Exit(1)
		}
		if err := <-serveErr; err != nil {
			logger.Error("listener returned error", slog.String("error", err.Error()))
			os.Exit(1)
		}
	case err := <-serveErr:
		if err != nil {
			logger.Error("server failed", slog.String("error", err.Error()))
			os.Exit(1)
		}
	}
}

// config holds runtime configuration sourced from the environment.
type config struct {
	addr     string
	logLevel string
}

func loadConfig() config {
	cfg := config{
		addr:     defaultAddr,
		logLevel: defaultLogLevel,
	}
	if v := os.Getenv("GOVIZ_ADDR"); v != "" {
		cfg.addr = v
	}
	if v := os.Getenv("GOVIZ_LOG_LEVEL"); v != "" {
		cfg.logLevel = v
	}
	return cfg
}

// newLogger builds a JSON slog logger with the requested verbosity.
// Unknown level strings fall back to info.
func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}

// newMux registers all HTTP routes and returns a ready-to-serve mux.
// startedAt is captured so /api/healthz can report process uptime.
func newMux(startedAt time.Time) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/healthz", healthHandler(startedAt, &activeProjects))
	return mux
}

// activeProjects is a placeholder counter for the number of live projects.
// Real bookkeeping is wired up in T13 alongside the orchestrator.
var activeProjects atomic.Int64

// healthResponse mirrors the schema in docs/api-contract.md §7.
type healthResponse struct {
	Status         string `json:"status"`
	Version        string `json:"version"`
	UptimeSec      int64  `json:"uptime_sec"`
	ActiveProjects int64  `json:"active_projects"`
}

// healthHandler returns a handler that always responds 200 with the
// service health envelope. It never returns 4xx/5xx — if the process is
// alive the answer is 200 (api-contract §7).
func healthHandler(startedAt time.Time, active *atomic.Int64) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		body := healthResponse{
			Status:         "ok",
			Version:        version,
			UptimeSec:      int64(time.Since(startedAt).Seconds()),
			ActiveProjects: active.Load(),
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(body); err != nil {
			// Response is already partially written; just record the failure.
			slog.Default().Error("encode health response", slog.String("error", err.Error()))
		}
	}
}

// Compile-time assertion that healthResponse stays JSON-encodable.
var _ = func() error {
	_, err := json.Marshal(healthResponse{})
	if err != nil {
		return fmt.Errorf("healthResponse not encodable: %w", err)
	}
	return nil
}

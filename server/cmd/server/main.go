// Command server starts the Go Dependencies Visualizer HTTP backend.
//
// The binary wires the disk cache manager and the api.Server into a single
// http.Server with graceful shutdown. POST /api/projects performs a real
// upload + ZIP unpack via the loader package; the analyze / graph / dead-code
// endpoints remain placeholders filled in by tasks T15–T16.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/api"
	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/entry"
	"github.com/vanek-goriachev/incogodevi/server/internal/graph"
	"github.com/vanek-goriachev/incogodevi/server/internal/orchestrator"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
	"github.com/vanek-goriachev/incogodevi/server/internal/reach"
	"github.com/vanek-goriachev/incogodevi/server/internal/web"
)

// version is the build-time version string. Bumped together with releases.
// It is declared as a var (not a const) so release builds can inject the real
// tag via -ldflags "-X main.version=...". See Dockerfile and Makefile.
var version = "0.1.0-dev"

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

	cacheMgr, err := cache.New(cache.Options{Logger: logger})
	if err != nil {
		logger.Error("cache init", slog.String("error", err.Error()))
		os.Exit(1)
	}
	defer func() {
		if cerr := cacheMgr.Close(); cerr != nil {
			logger.Error("cache close", slog.String("error", cerr.Error()))
		}
	}()

	analyzer := orchestrator.New(orchestrator.Options{
		Cache:    cacheMgr,
		Parser:   parser.New(cacheMgr, logger),
		Builder:  graph.New(logger),
		Resolver: entry.New(logger),
		Reach:    reach.New(logger),
		Logger:   logger,
	})

	apiSrv, err := api.NewServer(api.Config{
		Cache:          cacheMgr,
		StaticFS:       web.DistFS(),
		Logger:         logger,
		Version:        version,
		StartedAt:      time.Now(),
		TrustedOrigins: parseList(os.Getenv("GOVIZ_TRUSTED_ORIGINS")),
		Analyzer:       analyzer,
	})
	if err != nil {
		logger.Error("api init", slog.String("error", err.Error()))
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           apiSrv.Handler(),
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
		logger.Info("server starting",
			slog.String("addr", srv.Addr),
			slog.String("version", version),
		)
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

// parseList splits an environment variable on commas, trims whitespace and
// drops empty entries. Used to parse GOVIZ_TRUSTED_ORIGINS without pulling in
// a dedicated config library.
func parseList(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

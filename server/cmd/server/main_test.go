package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHealthzHandler(t *testing.T) {
	t.Parallel()

	startedAt := time.Now().Add(-5 * time.Second)
	mux := newMux(startedAt)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/api/healthz")
	if err != nil {
		t.Fatalf("GET /api/healthz: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type: got %q", got)
	}

	var body healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Status != "ok" {
		t.Errorf("status field: got %q, want ok", body.Status)
	}
	if body.Version != version {
		t.Errorf("version field: got %q, want %q", body.Version, version)
	}
	if body.UptimeSec < 4 {
		t.Errorf("uptime_sec: got %d, want >= 4", body.UptimeSec)
	}
	if body.ActiveProjects != 0 {
		t.Errorf("active_projects: got %d, want 0", body.ActiveProjects)
	}
}

func TestHealthzMethodNotAllowed(t *testing.T) {
	t.Parallel()

	mux := newMux(time.Now())
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/healthz", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do POST: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status: got %d, want 405", resp.StatusCode)
	}
}

func TestNewLoggerLevels(t *testing.T) {
	t.Parallel()

	cases := []string{"debug", "INFO", "Warn", "warning", "error", "", "bogus"}
	for _, in := range cases {
		in := in
		t.Run(in, func(t *testing.T) {
			t.Parallel()
			if got := newLogger(in); got == nil {
				t.Fatalf("newLogger(%q) returned nil", in)
			}
		})
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	t.Setenv("GOVIZ_ADDR", "")
	t.Setenv("GOVIZ_LOG_LEVEL", "")

	cfg := loadConfig()
	if cfg.addr != defaultAddr {
		t.Errorf("addr: got %q, want %q", cfg.addr, defaultAddr)
	}
	if cfg.logLevel != defaultLogLevel {
		t.Errorf("logLevel: got %q, want %q", cfg.logLevel, defaultLogLevel)
	}
}

func TestLoadConfigOverrides(t *testing.T) {
	t.Setenv("GOVIZ_ADDR", ":9090")
	t.Setenv("GOVIZ_LOG_LEVEL", "debug")

	cfg := loadConfig()
	if cfg.addr != ":9090" {
		t.Errorf("addr override: got %q", cfg.addr)
	}
	if cfg.logLevel != "debug" {
		t.Errorf("logLevel override: got %q", cfg.logLevel)
	}
}

package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// testFS is the minimal fs.FS used by tests; the embed package contains the
// real placeholder.
func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>test</title>")},
	}
}

// newTestServer constructs an api.Server backed by a real cache.Manager
// rooted in t.TempDir(). Cleanup is registered so each test gets a fresh
// disk-cache root and the sweeper goroutine terminates promptly.
func newTestServer(t *testing.T) (*Server, cache.Manager) {
	t.Helper()
	mgr, err := cache.New(cache.Options{
		RootTmp:       t.TempDir(),
		RootCache:     t.TempDir(),
		IdleTTL:       time.Hour,
		SweepInterval: time.Hour,
		Logger:        slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	srv, err := NewServer(Config{
		Cache:     mgr,
		StaticFS:  testFS(),
		Logger:    slog.New(slog.DiscardHandler),
		Version:   "test",
		StartedAt: time.Now().Add(-5 * time.Second),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return srv, mgr
}

func TestNewServer_RequiresDependencies(t *testing.T) {
	t.Parallel()

	if _, err := NewServer(Config{StaticFS: testFS()}); err == nil {
		t.Errorf("expected error when Cache is nil")
	}
	mgr, _ := cache.New(cache.Options{
		RootTmp:   t.TempDir(),
		RootCache: t.TempDir(),
		Logger:    slog.New(slog.DiscardHandler),
	})
	t.Cleanup(func() { _ = mgr.Close() })
	if _, err := NewServer(Config{Cache: mgr}); err == nil {
		t.Errorf("expected error when StaticFS is nil")
	}
}

func TestNewServer_DefaultsApplied(t *testing.T) {
	t.Parallel()

	mgr, _ := cache.New(cache.Options{
		RootTmp:   t.TempDir(),
		RootCache: t.TempDir(),
		Logger:    slog.New(slog.DiscardHandler),
	})
	t.Cleanup(func() { _ = mgr.Close() })

	srv, err := NewServer(Config{Cache: mgr, StaticFS: testFS()})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	if srv.version != "dev" {
		t.Errorf("default version: got %q", srv.version)
	}
	if srv.startedAt.IsZero() {
		t.Errorf("default startedAt should be set")
	}
	if srv.logger == nil {
		t.Errorf("logger must not be nil")
	}
}

func TestHealthz(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/healthz")
	if err != nil {
		t.Fatalf("GET healthz: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != jsonContentType {
		t.Errorf("Content-Type: got %q", got)
	}
	var body healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Status != "ok" {
		t.Errorf("status field: %q", body.Status)
	}
	if body.Version != "test" {
		t.Errorf("version: %q", body.Version)
	}
	if body.UptimeSec < 4 {
		t.Errorf("uptime_sec: %d", body.UptimeSec)
	}
	if body.ActiveProjects != 0 {
		t.Errorf("active_projects: %d", body.ActiveProjects)
	}
}

func TestHealthz_UsesActiveProjectsCounter(t *testing.T) {
	t.Parallel()

	mgr, _ := cache.New(cache.Options{
		RootTmp:   t.TempDir(),
		RootCache: t.TempDir(),
		Logger:    slog.New(slog.DiscardHandler),
	})
	t.Cleanup(func() { _ = mgr.Close() })

	var counter atomic.Int64
	counter.Store(7)
	srv, err := NewServer(Config{
		Cache:          mgr,
		StaticFS:       testFS(),
		Logger:         slog.New(slog.DiscardHandler),
		ActiveProjects: &counter,
		StartedAt:      time.Now(),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/healthz")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	var body healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.ActiveProjects != 7 {
		t.Errorf("active_projects: got %d, want 7", body.ActiveProjects)
	}
}

func TestListProjects_Empty(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/projects")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	var body projectsListResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Count != 0 || len(body.Projects) != 0 {
		t.Errorf("expected empty list, got %+v", body)
	}
	if body.CacheBytesTotal != 0 {
		t.Errorf("cache_bytes_total: %d", body.CacheBytesTotal)
	}
}

func TestListProjects_PopulatedAndSortedNewestFirst(t *testing.T) {
	t.Parallel()

	srv, mgr := newTestServer(t)
	older, err := mgr.NewProject("older", 100, 1)
	if err != nil {
		t.Fatalf("NewProject older: %v", err)
	}
	time.Sleep(10 * time.Millisecond)
	newer, err := mgr.NewProject("newer", 200, 2)
	if err != nil {
		t.Fatalf("NewProject newer: %v", err)
	}

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/projects")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	var body projectsListResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Count != 2 {
		t.Fatalf("count: got %d, want 2", body.Count)
	}
	if body.Projects[0].ProjectID != newer.Meta.ID {
		t.Errorf("expected newest project first, got %s then %s",
			body.Projects[0].ProjectID, body.Projects[1].ProjectID)
	}
	if body.Projects[1].ProjectID != older.Meta.ID {
		t.Errorf("second entry: got %s", body.Projects[1].ProjectID)
	}
	if body.CacheBytesTotal != 300 {
		t.Errorf("cache_bytes_total: %d", body.CacheBytesTotal)
	}
}

func TestDeleteProject_NotFound(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	id := domain.NewProjectID()
	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/projects/"+string(id), nil)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: got %d, want 404", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"project_not_found"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestDeleteProject_BadID_ReturnsNotFound(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/projects/garbage", nil)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: got %d, want 404", resp.StatusCode)
	}
}

func TestDeleteProject_Success(t *testing.T) {
	t.Parallel()

	srv, mgr := newTestServer(t)
	project, err := mgr.NewProject("doomed", 1, 1)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/projects/"+string(project.Meta.ID), nil)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status: got %d, want 204", resp.StatusCode)
	}

	if _, err := mgr.GetProject(project.Meta.ID); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Errorf("project should be gone, got err=%v", err)
	}

	// Second call returns 404 — DELETE is idempotent on the cache layer
	// but the API surfaces "no such project" once it has actually been
	// removed.
	resp2, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("DELETE second: %v", err)
	}
	t.Cleanup(func() { _ = resp2.Body.Close() })
	if resp2.StatusCode != http.StatusNotFound {
		t.Errorf("second status: got %d, want 404", resp2.StatusCode)
	}
}

func TestPlaceholders_Return501(t *testing.T) {
	t.Parallel()

	srv, mgr := newTestServer(t)
	project, _ := mgr.NewProject("any", 1, 1)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	cases := []struct {
		name   string
		method string
		path   string
		body   io.Reader
	}{
		{"analyze", http.MethodPost, "/api/projects/" + string(project.Meta.ID) + "/analyze", strings.NewReader("{}")},
		{"graph", http.MethodGet, "/api/projects/" + string(project.Meta.ID) + "/graph", nil},
		{"deadcode", http.MethodGet, "/api/projects/" + string(project.Meta.ID) + "/dead-code", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			req, _ := http.NewRequest(c.method, ts.URL+c.path, c.body)
			resp, err := ts.Client().Do(req)
			if err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
			t.Cleanup(func() { _ = resp.Body.Close() })
			if resp.StatusCode != http.StatusNotImplemented {
				t.Errorf("status: got %d, want 501", resp.StatusCode)
			}
			body, _ := io.ReadAll(resp.Body)
			if !strings.Contains(string(body), `"code":"not_implemented"`) {
				t.Errorf("envelope: %s", body)
			}
		})
	}
}

func TestPlaceholders_BadIDReturns404(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/projects/garbage/analyze"},
		{http.MethodGet, "/api/projects/garbage/graph"},
		{http.MethodGet, "/api/projects/garbage/dead-code"},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			t.Parallel()
			req, _ := http.NewRequest(c.method, ts.URL+c.path, nil)
			resp, err := ts.Client().Do(req)
			if err != nil {
				t.Fatalf("do: %v", err)
			}
			t.Cleanup(func() { _ = resp.Body.Close() })
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("status: %d, want 404", resp.StatusCode)
			}
		})
	}
}

func TestUpload_NonMultipartReturnsInvalidZip(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/projects",
		strings.NewReader("not multipart"))
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"invalid_zip"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestStaticIndex_Served(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "<!doctype html>") {
		t.Errorf("body: %s", body)
	}
}

func TestStaticMissing_ReturnsServerNotCrash(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/missing-asset.css")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: got %d, want 404", resp.StatusCode)
	}
}

func TestCORSChain_RejectsCrossOrigin(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/healthz", nil)
	req.Header.Set("Origin", "https://evil.com")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
}

func TestRecoverChain_PanicReturnsEnvelope(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	srv.Mux().HandleFunc("GET /debug/panic", func(http.ResponseWriter, *http.Request) {
		panic("kaboom")
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/debug/panic")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"internal"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestSSEFlusherPropagation(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	srv.Mux().HandleFunc("GET /debug/sse", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Errorf("middleware swallowed http.Flusher")
			return
		}
		_, _ = w.Write([]byte("event: phase\ndata: {\"phase\":\"loading\"}\n\n"))
		flusher.Flush()
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/debug/sse")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "event: phase") {
		t.Errorf("payload: %s", body)
	}
}

func TestRequestIDPropagatedToResponse(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/healthz")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if got := resp.Header.Get(requestIDHeader); got == "" {
		t.Fatalf("missing %s", requestIDHeader)
	}
}

package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// fakeAnalyzer is a deterministic stand-in for *orchestrator.Orchestrator
// used by handler-level tests. Each method delegates to an injected closure
// so individual tests pin down the exact behaviour (single-flight winner,
// preflight rejection, pipeline outcome) without spinning up the heavy
// parser/graph/reach stack.
type fakeAnalyzer struct {
	reserveFn   func(id domain.ProjectID) (func(), bool)
	preflightFn func(spec domain.EntryPointSpec, filters domain.Filters) error
	runFn       func(ctx context.Context, id domain.ProjectID, spec domain.EntryPointSpec, filters domain.Filters, stream *SSEStreamer) error

	// Captured arguments for assertions.
	mu             sync.Mutex
	lastSpec       domain.EntryPointSpec
	lastFilters    domain.Filters
	lastID         domain.ProjectID
	reserveCalls   int32
	preflightCalls int32
	runCalls       int32
}

func (f *fakeAnalyzer) Reserve(id domain.ProjectID) (func(), bool) {
	atomic.AddInt32(&f.reserveCalls, 1)
	if f.reserveFn != nil {
		return f.reserveFn(id)
	}
	return func() {}, true
}

func (f *fakeAnalyzer) PreflightValidate(spec domain.EntryPointSpec, filters domain.Filters) error {
	atomic.AddInt32(&f.preflightCalls, 1)
	if f.preflightFn != nil {
		return f.preflightFn(spec, filters)
	}
	return nil
}

func (f *fakeAnalyzer) RunReserved(ctx context.Context, id domain.ProjectID, spec domain.EntryPointSpec, filters domain.Filters, stream *SSEStreamer) error {
	atomic.AddInt32(&f.runCalls, 1)
	f.mu.Lock()
	f.lastSpec = spec
	f.lastFilters = filters
	f.lastID = id
	f.mu.Unlock()
	if f.runFn != nil {
		return f.runFn(ctx, id, spec, filters, stream)
	}
	if err := stream.Emit(domain.EventPhase, map[string]any{"phase": "loading"}); err != nil {
		return err
	}
	return stream.Emit(domain.EventDone, map[string]any{"phase": "done", "elapsed_ms": 1})
}

// newAnalyzeServer wraps newTestServer and additionally injects a fake
// analyzer into the freshly-built api.Server. The analyzer field is private
// so we mutate it directly — this is the simplest way to reuse the existing
// test helper without duplicating cache setup.
func newAnalyzeServer(t *testing.T, an Analyzer) (*Server, cache.Manager) {
	t.Helper()
	srv, mgr := newTestServer(t)
	srv.analyzer = an
	return srv, mgr
}

// postAnalyzeRaw submits a POST /analyze with the supplied body and returns
// the response. Tests own response.Body lifecycle.
func postAnalyzeRaw(t *testing.T, ts *httptest.Server, id domain.ProjectID, body []byte) *http.Response {
	t.Helper()
	url := ts.URL + "/api/projects/" + string(id) + "/analyze"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	return resp
}

// readAll drains body to a string. It cleans up after itself so callers do not
// have to remember a defer.
func readAll(t *testing.T, body io.ReadCloser) string {
	t.Helper()
	defer func() { _ = body.Close() }()
	raw, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(raw)
}

// sseFrame mirrors the orchestrator-side helper so the assertions remain
// self-contained.
type sseFrame struct {
	Event string
	Data  map[string]any
}

func parseSSEFrames(t *testing.T, body string) []sseFrame {
	t.Helper()
	body = strings.TrimRight(body, "\n")
	if body == "" {
		return nil
	}
	chunks := strings.Split(body, "\n\n")
	out := make([]sseFrame, 0, len(chunks))
	for _, chunk := range chunks {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" || strings.HasPrefix(chunk, ":") {
			continue
		}
		f := sseFrame{}
		for _, ln := range strings.Split(chunk, "\n") {
			switch {
			case strings.HasPrefix(ln, "event: "):
				f.Event = strings.TrimPrefix(ln, "event: ")
			case strings.HasPrefix(ln, "data: "):
				raw := strings.TrimPrefix(ln, "data: ")
				if err := json.Unmarshal([]byte(raw), &f.Data); err != nil {
					t.Fatalf("decode data %q: %v", raw, err)
				}
			}
		}
		if f.Event == "" {
			continue
		}
		out = append(out, f)
	}
	return out
}

// requireProject writes a minimal project to cache and returns its id so each
// test can hit /analyze without going through the full multipart upload.
func requireProject(t *testing.T, mgr cache.Manager) domain.ProjectID {
	t.Helper()
	p, err := mgr.NewProject("analyze-fixture", 1, 1)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	return p.Meta.ID
}

func TestAnalyze_HappyPath(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, []byte(`{"entry_points":{"mode":"auto"}}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Errorf("Content-Type: got %q", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control: got %q", got)
	}
	if got := resp.Header.Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("X-Accel-Buffering: got %q", got)
	}
	if got := resp.Header.Get("Connection"); got != "keep-alive" {
		t.Errorf("Connection: got %q", got)
	}

	body := readAll(t, resp.Body)
	frames := parseSSEFrames(t, body)
	if len(frames) < 2 {
		t.Fatalf("expected at least 2 SSE frames, got %v", frames)
	}
	last := frames[len(frames)-1]
	if last.Event != "done" || last.Data["phase"] != "done" {
		t.Fatalf("last frame: %+v", last)
	}
	if atomic.LoadInt32(&an.runCalls) != 1 {
		t.Fatalf("expected 1 RunReserved call, got %d", an.runCalls)
	}
}

func TestAnalyze_EmptyBodyAppliesDefaults(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
	_ = readAll(t, resp.Body)

	an.mu.Lock()
	defer an.mu.Unlock()
	defaults := domain.DefaultEntryPointSpec()
	if an.lastSpec.Mode != defaults.Mode {
		t.Errorf("mode default lost: got %q, want %q", an.lastSpec.Mode, defaults.Mode)
	}
	if len(an.lastFilters.IncludeKinds) != len(domain.AllNodeKinds) {
		t.Errorf("include_kinds: got %d, want %d", len(an.lastFilters.IncludeKinds), len(domain.AllNodeKinds))
	}
	if !an.lastFilters.StdlibExclude {
		t.Errorf("stdlib_exclude default must be true")
	}
}

func TestAnalyze_ProjectNotFound(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{}
	srv, _ := newAnalyzeServer(t, an)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, domain.NewProjectID(), []byte(`{}`))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: got %d, want 404", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Errorf("Content-Type: got %q, want JSON", got)
	}
	body := readAll(t, resp.Body)
	if !strings.Contains(body, `"code":"project_not_found"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestAnalyze_BadIDReturnsNotFound(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{}
	srv, _ := newAnalyzeServer(t, an)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/projects/garbage/analyze", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: %d", resp.StatusCode)
	}
}

func TestAnalyze_InvalidFilter(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, []byte(`{"filters":{"include_kinds":["package","bogus","also_bad"]}}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Errorf("Content-Type: got %q, want JSON", got)
	}
	body := readAll(t, resp.Body)
	if !strings.Contains(body, `"code":"invalid_filters"`) {
		t.Errorf("envelope: %s", body)
	}
	if !strings.Contains(body, "bogus") || !strings.Contains(body, "also_bad") {
		t.Errorf("invalid kinds must surface in details: %s", body)
	}
	if atomic.LoadInt32(&an.runCalls) != 0 {
		t.Errorf("RunReserved must not be called when filters fail")
	}
}

func TestAnalyze_InvalidJSON(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, []byte(`{not json`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
	body := readAll(t, resp.Body)
	if !strings.Contains(body, `"code":"invalid_body"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestAnalyze_UnknownField(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, []byte(`{"surprise":1}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
}

func TestAnalyze_TrailingJSON(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, []byte(`{}{}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
}

func TestAnalyze_PreflightRejectsInvalidEntryPoint(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{
		preflightFn: func(spec domain.EntryPointSpec, _ domain.Filters) error {
			return &domain.APIError{
				Code:       "invalid_entry_point",
				Message:    "boom",
				HTTPStatus: http.StatusBadRequest,
			}
		},
	}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, []byte(`{"entry_points":{"mode":"manual","manual":["bad"]}}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
	body := readAll(t, resp.Body)
	if !strings.Contains(body, `"code":"invalid_entry_point"`) {
		t.Errorf("envelope: %s", body)
	}
	if atomic.LoadInt32(&an.runCalls) != 0 {
		t.Errorf("RunReserved must not be called when preflight fails")
	}
}

func TestAnalyze_AnalysisInProgressReturnsJSON(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{
		reserveFn: func(_ domain.ProjectID) (func(), bool) {
			return func() {}, false
		},
	}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, []byte(`{}`))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status: got %d, want 409", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Errorf("Content-Type: got %q, want JSON not SSE", got)
	}
	body := readAll(t, resp.Body)
	if !strings.Contains(body, `"code":"analysis_in_progress"`) {
		t.Errorf("envelope: %s", body)
	}
	if atomic.LoadInt32(&an.runCalls) != 0 {
		t.Errorf("RunReserved must not be called when reservation fails")
	}
}

func TestAnalyze_PipelineFailureSurfacedInSSE(t *testing.T) {
	t.Parallel()
	pipelineErr := errors.New("parser exploded")
	an := &fakeAnalyzer{
		runFn: func(_ context.Context, _ domain.ProjectID, _ domain.EntryPointSpec, _ domain.Filters, stream *SSEStreamer) error {
			_ = stream.Emit(domain.EventDone, map[string]any{
				"phase": "failed",
				"error": map[string]any{"code": "parse_failed", "message": pipelineErr.Error()},
			})
			return pipelineErr
		},
	}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, []byte(`{}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, want 200", resp.StatusCode)
	}
	frames := parseSSEFrames(t, readAll(t, resp.Body))
	if len(frames) == 0 {
		t.Fatal("expected at least one SSE frame")
	}
	last := frames[len(frames)-1]
	if last.Event != "done" || last.Data["phase"] != "failed" {
		t.Fatalf("last frame: %+v", last)
	}
}

func TestAnalyze_AnalyzerMissingReturns500(t *testing.T) {
	t.Parallel()
	srv, mgr := newAnalyzeServer(t, nil)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp := postAnalyzeRaw(t, ts, id, []byte(`{}`))
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status: got %d", resp.StatusCode)
	}
}

func TestAnalyze_BodyTooLarge(t *testing.T) {
	t.Parallel()
	an := &fakeAnalyzer{}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// 2 MiB of padding inside a JSON-shaped wrapper. The handler's
	// MaxBytesReader trips before the decoder gets to the closing brace.
	pad := strings.Repeat("a", 2<<20)
	body := []byte(`{"entry_points":{"manual":["` + pad + `"]}}`)
	resp := postAnalyzeRaw(t, ts, id, body)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status: got %d, want 413", resp.StatusCode)
	}
	got := readAll(t, resp.Body)
	if !strings.Contains(got, `"code":"body_too_large"`) {
		t.Errorf("envelope: %s", got)
	}
}

func TestAnalyze_SingleFlightTwoConcurrentRequests(t *testing.T) {
	t.Parallel()
	gate := make(chan struct{})
	release := make(chan struct{})
	var inflight int32
	var maxInflight int32
	an := &fakeAnalyzer{
		// Reserve uses a real per-id mutex so the second request observes a
		// busy slot and gets 409 without blocking on RunReserved.
		reserveFn: realReserve(),
		runFn: func(_ context.Context, _ domain.ProjectID, _ domain.EntryPointSpec, _ domain.Filters, stream *SSEStreamer) error {
			cur := atomic.AddInt32(&inflight, 1)
			defer atomic.AddInt32(&inflight, -1)
			for {
				old := atomic.LoadInt32(&maxInflight)
				if cur <= old || atomic.CompareAndSwapInt32(&maxInflight, old, cur) {
					break
				}
			}
			select {
			case <-gate:
			default:
				close(gate)
			}
			<-release
			return stream.Emit(domain.EventDone, map[string]any{"phase": "done", "elapsed_ms": 1})
		},
	}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	type result struct {
		status int
		body   string
	}
	out := make(chan result, 2)
	go func() {
		resp := postAnalyzeRaw(t, ts, id, []byte(`{}`))
		out <- result{resp.StatusCode, readAll(t, resp.Body)}
	}()
	<-gate
	resp := postAnalyzeRaw(t, ts, id, []byte(`{}`))
	out <- result{resp.StatusCode, readAll(t, resp.Body)}
	close(release)

	r1 := <-out
	r2 := <-out
	pair := []result{r1, r2}
	var ok, conflict result
	for _, r := range pair {
		switch r.status {
		case http.StatusOK:
			ok = r
		case http.StatusConflict:
			conflict = r
		}
	}
	if ok.status == 0 {
		t.Fatalf("no 200 response in pair: %+v", pair)
	}
	if conflict.status == 0 {
		t.Fatalf("no 409 response in pair: %+v", pair)
	}
	if !strings.Contains(conflict.body, `"code":"analysis_in_progress"`) {
		t.Errorf("409 body must carry analysis_in_progress: %s", conflict.body)
	}
	if got := atomic.LoadInt32(&maxInflight); got != 1 {
		t.Errorf("max concurrent runs = %d, want 1", got)
	}
}

// realReserve returns a closure that mimics orchestrator.Orchestrator.Reserve
// using a sync.Map of mutexes keyed by ProjectID. The handler does not need
// the real orchestrator here, only its single-flight semantics.
func realReserve() func(domain.ProjectID) (func(), bool) {
	var inflight sync.Map
	return func(id domain.ProjectID) (func(), bool) {
		v, _ := inflight.LoadOrStore(id, &sync.Mutex{})
		mu := v.(*sync.Mutex)
		if !mu.TryLock() {
			return func() {}, false
		}
		var once sync.Once
		return func() { once.Do(mu.Unlock) }, true
	}
}

func TestAnalyze_ClientDisconnectExitsPromptly(t *testing.T) {
	t.Parallel()

	pipelineEntered := make(chan struct{})
	pipelineExited := make(chan struct{})
	an := &fakeAnalyzer{
		runFn: func(ctx context.Context, _ domain.ProjectID, _ domain.EntryPointSpec, _ domain.Filters, stream *SSEStreamer) error {
			defer close(pipelineExited)
			close(pipelineEntered)
			if err := stream.Emit(domain.EventPhase, map[string]any{"phase": "loading"}); err != nil {
				return err
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
				return fmt.Errorf("client did not disconnect in time")
			}
		},
	}
	srv, mgr := newAnalyzeServer(t, an)
	id := requireProject(t, mgr)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	url := ts.URL + "/api/projects/" + string(id) + "/analyze"
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	ctx, cancel := context.WithCancel(context.Background())
	req = req.WithContext(ctx)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	// Drain the first event so the pipeline goroutine has definitely
	// reached its select before we cancel.
	<-pipelineEntered
	buf := make([]byte, 256)
	if _, err := resp.Body.Read(buf); err != nil && !errors.Is(err, io.EOF) {
		t.Logf("read: %v", err)
	}
	cancel()
	_ = resp.Body.Close()

	select {
	case <-pipelineExited:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("pipeline did not exit within 500ms after client disconnect")
	}
}

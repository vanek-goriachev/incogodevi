package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestID_GeneratesWhenAbsent(t *testing.T) {
	t.Parallel()

	var seenInHandler string
	h := RequestID()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenInHandler = RequestIDFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	got := rec.Header().Get(requestIDHeader)
	if got == "" {
		t.Fatalf("missing %s header", requestIDHeader)
	}
	if got != seenInHandler {
		t.Fatalf("context id %q != header id %q", seenInHandler, got)
	}
	if len(got) != 16 {
		t.Errorf("expected 16-hex id, got %q", got)
	}
}

func TestRequestID_ReusesValidClientHeader(t *testing.T) {
	t.Parallel()

	const provided = "client-supplied-1234"
	h := RequestID()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := RequestIDFromContext(r.Context()); got != provided {
			t.Errorf("context id: got %q, want %q", got, provided)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set(requestIDHeader, provided)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get(requestIDHeader); got != provided {
		t.Errorf("header echo: got %q, want %q", got, provided)
	}
}

func TestRequestID_RejectsBogusClientHeader(t *testing.T) {
	t.Parallel()

	cases := []string{"", "  ", "tiny", strings.Repeat("a", 65), "with\x00null"}
	for _, in := range cases {
		t.Run(in, func(t *testing.T) {
			t.Parallel()
			h := RequestID()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))
			req := httptest.NewRequest(http.MethodGet, "/x", nil)
			if in != "" {
				req.Header.Set(requestIDHeader, in)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			got := rec.Header().Get(requestIDHeader)
			if got == in {
				t.Errorf("header should have been replaced, kept %q", got)
			}
			if got == "" {
				t.Errorf("expected generated id, got empty")
			}
		})
	}
}

func TestRequestIDFromContext_NoValue(t *testing.T) {
	t.Parallel()
	if got := RequestIDFromContext(context.Background()); got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}

func TestRecover_ReturnsEnvelope(t *testing.T) {
	t.Parallel()

	logBuf := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	mw := Recover(logger)
	h := mw(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		panic("boom")
	}))

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status: got %d, want 500", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"code":"internal"`) {
		t.Errorf("envelope body missing code: %s", body)
	}
	if !strings.Contains(logBuf.String(), "panic recovered") {
		t.Errorf("expected panic log, got %s", logBuf.String())
	}
	if !strings.Contains(logBuf.String(), "stack") {
		t.Errorf("expected stack trace in log, got %s", logBuf.String())
	}
}

func TestRecover_NilLoggerFallsBackToDefault(t *testing.T) {
	t.Parallel()

	h := Recover(nil)(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		panic("boom")
	}))
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status: got %d, want 500", rec.Code)
	}
}

func TestRecover_PassesThroughErrAbortHandler(t *testing.T) {
	t.Parallel()

	defer func() {
		if r := recover(); r == nil {
			t.Fatalf("expected panic to propagate, got nothing")
		} else if r != http.ErrAbortHandler {
			t.Fatalf("expected ErrAbortHandler, got %v", r)
		}
	}()

	h := Recover(slog.New(slog.DiscardHandler))(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		panic(http.ErrAbortHandler)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
}

func TestAccessLog_RecordsStatusAndDuration(t *testing.T) {
	t.Parallel()

	logBuf := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	mw := AccessLog(logger)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("hi"))
	}))

	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusTeapot {
		t.Fatalf("status: got %d, want 418", rec.Code)
	}
	var entry map[string]any
	if err := json.Unmarshal(logBuf.Bytes(), &entry); err != nil {
		t.Fatalf("decode log: %v (%s)", err, logBuf.String())
	}
	if entry["status"].(float64) != float64(http.StatusTeapot) {
		t.Errorf("logged status: %v", entry["status"])
	}
	if entry["bytes"].(float64) != 2 {
		t.Errorf("logged bytes: %v", entry["bytes"])
	}
	if entry["method"] != http.MethodPost {
		t.Errorf("logged method: %v", entry["method"])
	}
}

func TestAccessLog_ImplicitOK(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.DiscardHandler)
	rec := newResponseRecorder(httptest.NewRecorder())
	if got := rec.statusCode(); got != http.StatusOK {
		t.Errorf("default status: got %d, want 200", got)
	}
	mw := AccessLog(logger)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/", nil))
	if resp.Code != http.StatusOK {
		t.Errorf("status: %d", resp.Code)
	}
}

func TestCORS_AllowsMissingOrigin(t *testing.T) {
	t.Parallel()

	called := false
	h := CORS()(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !called {
		t.Fatalf("handler not invoked for empty origin")
	}
}

func TestCORS_AllowsSameOrigin(t *testing.T) {
	t.Parallel()

	cases := []struct {
		host   string
		origin string
	}{
		{"example.test:8080", "http://example.test:8080"},
		{"localhost:8080", "http://localhost:8080"},
		{"example.test", "http://example.test"},
	}
	for _, c := range cases {
		t.Run(c.origin, func(t *testing.T) {
			t.Parallel()
			called := false
			h := CORS()(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { called = true }))
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Host = c.host
			req.Header.Set("Origin", c.origin)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if !called {
				t.Fatalf("handler not invoked for same-origin request")
			}
		})
	}
}

func TestCORS_RejectsCrossOrigin(t *testing.T) {
	t.Parallel()

	h := CORS()(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatalf("handler should not be invoked")
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "localhost:8080"
	req.Header.Set("Origin", "https://evil.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status: got %d, want 403", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"code":"forbidden_origin"`) {
		t.Errorf("envelope body: %s", rec.Body.String())
	}
}

func TestCORS_AllowsExtraTrustedOrigin(t *testing.T) {
	t.Parallel()

	called := false
	h := CORS("https://allowed.test")(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { called = true }))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "localhost:8080"
	req.Header.Set("Origin", "https://allowed.test")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !called {
		t.Fatalf("trusted origin should pass through")
	}
}

func TestCORS_MalformedOriginRejected(t *testing.T) {
	t.Parallel()

	h := CORS()(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatalf("handler should not be invoked")
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "localhost:8080"
	req.Header.Set("Origin", "://not-a-url")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status: got %d, want 403", rec.Code)
	}
}

func TestMaxBytes_Allows(t *testing.T) {
	t.Parallel()

	h := MaxBytes(16, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(buf)
	}))
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("hi"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
}

func TestMaxBytes_Overflow(t *testing.T) {
	t.Parallel()

	const limit int64 = 8
	var observedErr error
	h := MaxBytes(limit, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, observedErr = io.ReadAll(r.Body)
	}))
	body := strings.NewReader(strings.Repeat("a", int(limit)+8))
	req := httptest.NewRequest(http.MethodPost, "/x", body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !IsMaxBytesError(observedErr) {
		t.Fatalf("expected MaxBytesError, got %v", observedErr)
	}
	if got := MaxBytesLimit(observedErr); got != limit {
		t.Errorf("limit: got %d, want %d", got, limit)
	}
}

func TestMaxBytesLimit_NotMaxBytesError(t *testing.T) {
	t.Parallel()
	if got := MaxBytesLimit(errors.New("nope")); got != -1 {
		t.Errorf("expected -1, got %d", got)
	}
}

func TestChain_OrderOuterToInner(t *testing.T) {
	t.Parallel()

	var order []string
	tag := func(name string) Middleware {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, "before:"+name)
				next.ServeHTTP(w, r)
				order = append(order, "after:"+name)
			})
		}
	}
	final := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		order = append(order, "handler")
		w.WriteHeader(http.StatusOK)
	})
	h := chain(final, tag("a"), tag("b"))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	want := []string{"before:a", "before:b", "handler", "after:b", "after:a"}
	if len(order) != len(want) {
		t.Fatalf("order: got %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Errorf("order[%d]: got %q, want %q", i, order[i], want[i])
		}
	}
}

func TestResponseRecorder_PreservesFlusher(t *testing.T) {
	t.Parallel()

	flushable := &flushableRecorder{ResponseRecorder: httptest.NewRecorder()}
	rec := newResponseRecorder(flushable)

	if _, ok := any(rec).(http.Flusher); !ok {
		t.Fatalf("recorder must implement http.Flusher")
	}

	if _, err := rec.Write([]byte("x")); err != nil {
		t.Fatalf("write: %v", err)
	}
	rec.Flush()
	if !flushable.flushed {
		t.Errorf("inner Flush was not invoked")
	}
}

func TestResponseRecorder_FlushNoOpWithoutFlusher(t *testing.T) {
	t.Parallel()

	rec := newResponseRecorder(httptest.NewRecorder())
	rec.Flush() // must not panic
}

func TestResponseRecorder_HijackUnsupported(t *testing.T) {
	t.Parallel()

	rec := newResponseRecorder(httptest.NewRecorder())
	if _, _, err := rec.Hijack(); err == nil {
		t.Fatalf("expected error for non-hijackable writer")
	}
}

func TestResponseRecorder_Unwrap(t *testing.T) {
	t.Parallel()

	inner := httptest.NewRecorder()
	rec := newResponseRecorder(inner)
	if rec.Unwrap() != inner {
		t.Fatalf("Unwrap returned wrong writer")
	}
}

// flushableRecorder is a minimal http.Flusher wrapper around
// httptest.ResponseRecorder so we can verify the recorder propagates Flush.
type flushableRecorder struct {
	*httptest.ResponseRecorder
	flushed bool
}

func (f *flushableRecorder) Flush() { f.flushed = true; f.ResponseRecorder.Flush() }

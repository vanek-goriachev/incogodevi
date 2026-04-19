package api

import (
	"bufio"
	"errors"
	"net"
	"net/http"
)

// responseRecorder wraps a http.ResponseWriter so AccessLog can read back the
// chosen status code and bytes written, while still exposing http.Flusher and
// http.Hijacker so SSE streams (T13/T15) keep working.
//
// Go 1.26 ships http.NewResponseController which can route Flush/Hijack calls
// through a wrapper, but only if the wrapper itself implements no Flusher /
// Hijacker — the controller falls back to the inner writer via type
// assertion. We provide both interfaces explicitly so handlers using the
// classic w.(http.Flusher) idiom work without rewrites.
type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
	wrote  bool
}

func newResponseRecorder(w http.ResponseWriter) *responseRecorder {
	return &responseRecorder{ResponseWriter: w}
}

// WriteHeader records the chosen status code and forwards the call once.
func (r *responseRecorder) WriteHeader(status int) {
	if r.wrote {
		return
	}
	r.wrote = true
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Write records the byte count and emits an implicit 200 the same way
// http.ResponseWriter does.
func (r *responseRecorder) Write(b []byte) (int, error) {
	if !r.wrote {
		r.wrote = true
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

// statusCode returns the recorded status, defaulting to 200 if no Write or
// WriteHeader call ever reached the recorder (rare but legal — a handler may
// only set headers).
func (r *responseRecorder) statusCode() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

// Flush forwards to the underlying writer's Flusher implementation. SSE
// handlers depend on this; if the inner writer does not implement Flusher we
// silently no-op so handlers can still call Flush during tests with
// httptest.ResponseRecorder.
func (r *responseRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack forwards to the underlying writer's Hijacker implementation if any.
// Returning an error here lets callers detect non-hijackable transports
// (e.g. http2) and fall back gracefully.
func (r *responseRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := r.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errResponseNotHijackable
}

// Unwrap exposes the underlying ResponseWriter to http.NewResponseController
// (Go 1.20+). This is the recommended way to chain wrappers without losing
// optional interfaces in future Go releases.
func (r *responseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

var errResponseNotHijackable = errors.New("response writer does not support hijacking")

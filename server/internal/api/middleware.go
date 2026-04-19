package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

// Middleware is the canonical http middleware shape used throughout the
// package. Composition follows the standard outer-to-inner left-to-right
// reading order — see chain.
type Middleware func(http.Handler) http.Handler

// chain composes middlewares so the leftmost wrapper runs first on the way in
// and last on the way out.
func chain(h http.Handler, mws ...Middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// requestIDHeader is the canonical header used to surface a per-request id
// to clients and to log pipelines.
const requestIDHeader = "X-Request-Id"

// ctxKey is a private context-key type so external packages cannot collide
// with our values.
type ctxKey int

const (
	ctxKeyRequestID ctxKey = iota
)

// RequestIDFromContext returns the request id stored on ctx by the RequestID
// middleware. The empty string is returned if no id is present (e.g. when a
// handler is invoked outside the chain in tests).
func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKeyRequestID).(string); ok {
		return v
	}
	return ""
}

// RequestID either reuses a client-supplied X-Request-Id header (when it has
// a sane shape) or generates a fresh 16-hex-char id from crypto/rand. The id
// is propagated to handlers via context and echoed back on the response so
// browsers and proxies can correlate logs.
func RequestID() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := strings.TrimSpace(r.Header.Get(requestIDHeader))
			if !isPrintableASCII(id) || len(id) < 8 || len(id) > 64 {
				id = newRequestID()
			}
			w.Header().Set(requestIDHeader, id)
			ctx := context.WithValue(r.Context(), ctxKeyRequestID, id)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// newRequestID returns a 16-character lowercase hex id sourced from
// crypto/rand. We avoid pulling in a UUID dependency for ADR-11 reasons.
func newRequestID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand only fails on a fundamentally broken OS — fall back to
		// a deterministic but non-empty value so the chain keeps working.
		return fmt.Sprintf("noent-%016x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}

func isPrintableASCII(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r > 0x7e {
			return false
		}
	}
	return true
}

// Recover converts panics from downstream handlers into a 500 + JSON envelope
// while logging the stack trace at slog.Error. SSE handlers may have already
// flushed headers; in that case we still log the panic but cannot rewrite the
// status — the client will see a truncated stream which is the safest
// behaviour we can offer.
func Recover(logger *slog.Logger) Middleware {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				if errors.Is(asError(rec), http.ErrAbortHandler) {
					// http.ErrAbortHandler is the documented escape hatch for
					// a handler that has already taken responsibility for the
					// connection; honour it.
					panic(rec)
				}
				logger.Error("panic recovered",
					slog.Any("value", rec),
					slog.String("method", r.Method),
					slog.String("path", r.URL.Path),
					slog.String("request_id", RequestIDFromContext(r.Context())),
					slog.String("stack", string(debug.Stack())),
				)
				ww, ok := w.(*responseRecorder)
				if ok && ww.wrote {
					return
				}
				writeAPIError(w, r, errInternal())
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// asError adapts an arbitrary recover() value to the error interface so the
// caller can use errors.Is.
func asError(v any) error {
	if err, ok := v.(error); ok {
		return err
	}
	return fmt.Errorf("%v", v)
}

// AccessLog records one structured slog entry per request, including the
// resolved status code and number of bytes written. The wrapped
// ResponseWriter preserves http.Flusher and http.Hijacker semantics so SSE
// handlers downstream keep working.
func AccessLog(logger *slog.Logger) Middleware {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := newResponseRecorder(w)
			next.ServeHTTP(rec, r)
			logger.Info("http request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.statusCode()),
				slog.Int64("bytes", rec.bytes),
				slog.Duration("duration", time.Since(start)),
				slog.String("request_id", RequestIDFromContext(r.Context())),
				slog.String("remote", r.RemoteAddr),
			)
		})
	}
}

// CORS implements a strict same-origin policy: requests without an Origin
// header (curl, server-to-server, browser navigation) are allowed; requests
// with an Origin that does not match Host are rejected with 403. Trusted
// extra origins may be passed through for preview deployments and tests.
func CORS(extraTrusted ...string) Middleware {
	trusted := make(map[string]struct{}, len(extraTrusted))
	for _, o := range extraTrusted {
		o = strings.TrimSpace(o)
		if o != "" {
			trusted[o] = struct{}{}
		}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			if origin == "" {
				next.ServeHTTP(w, r)
				return
			}
			if originMatchesHost(origin, r) {
				next.ServeHTTP(w, r)
				return
			}
			if _, ok := trusted[origin]; ok {
				next.ServeHTTP(w, r)
				return
			}
			writeAPIError(w, r, errForbiddenOrigin(origin))
		})
	}
}

// originMatchesHost compares Origin (scheme://host[:port]) against the
// request's Host header. Both sides are normalised so :80/:443 mismatches
// across http/https schemes still match.
func originMatchesHost(origin string, r *http.Request) bool {
	scheme, host, ok := splitOrigin(origin)
	if !ok {
		return false
	}
	requestHost := strings.TrimSpace(r.Host)
	if requestHost == "" {
		return false
	}
	hostNoPort, hostPort := splitHostPort(host)
	reqHost, reqPort := splitHostPort(requestHost)
	if !strings.EqualFold(hostNoPort, reqHost) {
		return false
	}
	if hostPort == "" {
		hostPort = defaultPortForScheme(scheme)
	}
	if reqPort == "" {
		// Without an explicit port on the Host header we cannot tell if the
		// request hit the default port for the scheme; treat the host match
		// as sufficient.
		return true
	}
	return hostPort == reqPort
}

func splitOrigin(origin string) (scheme, host string, ok bool) {
	idx := strings.Index(origin, "://")
	if idx <= 0 {
		return "", "", false
	}
	scheme = strings.ToLower(origin[:idx])
	host = origin[idx+3:]
	if host == "" {
		return "", "", false
	}
	if i := strings.IndexAny(host, "/?#"); i >= 0 {
		host = host[:i]
	}
	return scheme, host, true
}

func splitHostPort(hp string) (host, port string) {
	h, p, err := net.SplitHostPort(hp)
	if err != nil {
		return hp, ""
	}
	return h, p
}

func defaultPortForScheme(scheme string) string {
	switch scheme {
	case "http", "ws":
		return "80"
	case "https", "wss":
		return "443"
	default:
		return ""
	}
}

// MaxBytes wraps a single handler and applies http.MaxBytesReader to the
// request body. A body that exceeds limit terminates with a MaxBytesError on
// the next read; downstream handlers detect this via IsMaxBytesError and
// emit the canonical 413 envelope.
//
// The helper lives outside the global middleware chain because the limit is
// per-route (e.g. only the ZIP upload endpoint needs 50 MiB) — see
// docs/api-contract.md §1.
func MaxBytes(limit int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, limit)
		}
		next.ServeHTTP(w, r)
	})
}

// IsMaxBytesError reports whether err originates from http.MaxBytesReader.
func IsMaxBytesError(err error) bool {
	var mbe *http.MaxBytesError
	return errors.As(err, &mbe)
}

// MaxBytesLimit returns the byte limit recorded on a *http.MaxBytesError.
// Returns -1 if err is not a MaxBytesError.
func MaxBytesLimit(err error) int64 {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return mbe.Limit
	}
	return -1
}

package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// ErrStreamerNotFlushable is returned by NewSSEStreamer when the supplied
// http.ResponseWriter does not implement http.Flusher. Without Flush we cannot
// guarantee that events reach the client before the connection closes, so the
// orchestrator refuses to start.
var ErrStreamerNotFlushable = errors.New("api: response writer does not support flushing")

// SSEStreamer is a thin adapter over a single http.ResponseWriter that emits
// the wire format documented in docs/api-contract.md §2.
//
// Each Emit call serialises the payload to JSON, prepends an "event:" line,
// flushes the response and increments a per-connection sequence number. The
// streamer is not safe for concurrent use; callers (the orchestrator) drive
// it from a single goroutine.
type SSEStreamer struct {
	w       http.ResponseWriter
	flusher http.Flusher
	seq     int
}

// NewSSEStreamer prepares w for streaming by setting the four headers required
// by the SSE specification (and by NGINX-style proxies via X-Accel-Buffering)
// and verifying that the writer can be flushed. The headers are written
// immediately so the client receives a 200 OK before the first event.
func NewSSEStreamer(w http.ResponseWriter) (*SSEStreamer, error) {
	if w == nil {
		return nil, errors.New("api: NewSSEStreamer requires a non-nil ResponseWriter")
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, ErrStreamerNotFlushable
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")

	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	return &SSEStreamer{w: w, flusher: flusher}, nil
}

// Emit writes a single SSE frame in the canonical "event: …\ndata: …\n\n"
// format and flushes the underlying writer. The seq field of the JSON payload
// is overlaid by the streamer so callers can pass plain map/struct values
// without bookkeeping. If the payload already carries a "seq" key it is
// overwritten so the wire value is always monotonic per connection.
func (s *SSEStreamer) Emit(eventType string, payload any) error {
	if s == nil {
		return errors.New("api: Emit on nil streamer")
	}
	if eventType == "" {
		return errors.New("api: SSE event type must not be empty")
	}
	s.seq++
	envelope, err := buildSSEEnvelope(s.seq, payload)
	if err != nil {
		return fmt.Errorf("sse: encode payload: %w", err)
	}
	if _, err := fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", eventType, envelope); err != nil {
		return fmt.Errorf("sse: write frame: %w", err)
	}
	s.flusher.Flush()
	return nil
}

// Seq returns the sequence number of the most recently emitted event. It is
// 0 before the first call to Emit.
func (s *SSEStreamer) Seq() int { return s.seq }

// Close writes a terminating colon-comment line and flushes once more so the
// client sees an explicit end-of-stream marker. The HTTP framework owns the
// underlying TCP connection; we deliberately do not close it ourselves.
func (s *SSEStreamer) Close() error {
	if s == nil {
		return nil
	}
	if _, err := fmt.Fprint(s.w, ": end of stream\n\n"); err != nil {
		return fmt.Errorf("sse: write end-of-stream: %w", err)
	}
	s.flusher.Flush()
	return nil
}

// buildSSEEnvelope merges a sequence number into the user-supplied payload and
// returns the resulting JSON. When payload is a struct/map the seq key is
// added without losing any existing fields; nil payloads collapse to a
// `{"seq":N}` document so the wire shape is always an object.
func buildSSEEnvelope(seq int, payload any) ([]byte, error) {
	merged, err := mergeSeq(seq, payload)
	if err != nil {
		return nil, err
	}
	out, err := json.Marshal(merged)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// mergeSeq returns payload with a top-level "seq" entry overlaid. Structs and
// map[string]any values are decoded through json.Marshal so unexported fields
// stay invisible and tag aliases are honoured. For other shapes we fall back
// to a `{"seq":N,"value":payload}` envelope so the receiver can still parse
// the data.
func mergeSeq(seq int, payload any) (map[string]any, error) {
	if payload == nil {
		return map[string]any{"seq": seq}, nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		// Non-object payload: keep it under "value" to preserve the seq slot.
		var passthrough any
		if err := json.Unmarshal(raw, &passthrough); err != nil {
			return nil, err
		}
		return map[string]any{"seq": seq, "value": passthrough}, nil
	}
	if out == nil {
		out = make(map[string]any, 1)
	}
	out["seq"] = seq
	return out, nil
}

// SSEEventTypes is the list of SSE event names the orchestrator emits. It is
// re-exported from the domain package for tests and clients that work
// purely against the api/sse interface.
var SSEEventTypes = []string{
	domain.EventPhase,
	domain.EventPartialGraph,
	domain.EventWarning,
	domain.EventDone,
}

package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// nonFlushRecorder is an http.ResponseWriter that deliberately does not
// implement http.Flusher so NewSSEStreamer's type-assertion fails.
type nonFlushRecorder struct {
	header  http.Header
	written []byte
	status  int
}

func (n *nonFlushRecorder) Header() http.Header {
	if n.header == nil {
		n.header = make(http.Header)
	}
	return n.header
}

func (n *nonFlushRecorder) Write(b []byte) (int, error) {
	n.written = append(n.written, b...)
	return len(b), nil
}
func (n *nonFlushRecorder) WriteHeader(s int) { n.status = s }

func TestSSEStreamerHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	s, err := NewSSEStreamer(rec)
	if err != nil {
		t.Fatalf("NewSSEStreamer: %v", err)
	}
	if s == nil {
		t.Fatal("nil streamer")
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream prefix", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("Connection"); got != "keep-alive" {
		t.Fatalf("Connection = %q", got)
	}
	if got := rec.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("X-Accel-Buffering = %q", got)
	}
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !rec.Flushed {
		t.Fatalf("recorder should have been flushed by NewSSEStreamer")
	}
}

func TestSSEStreamerEmitFormat(t *testing.T) {
	rec := httptest.NewRecorder()
	s, err := NewSSEStreamer(rec)
	if err != nil {
		t.Fatalf("NewSSEStreamer: %v", err)
	}

	if err := s.Emit("phase", map[string]any{"phase": "loading"}); err != nil {
		t.Fatalf("Emit: %v", err)
	}

	body := rec.Body.String()
	frames := strings.Split(strings.TrimRight(body, "\n"), "\n\n")
	if len(frames) != 1 {
		t.Fatalf("want 1 frame, got %d: %q", len(frames), frames)
	}

	lines := strings.Split(frames[0], "\n")
	if len(lines) != 2 {
		t.Fatalf("frame should be 2 lines, got %d: %q", len(lines), lines)
	}
	if lines[0] != "event: phase" {
		t.Fatalf("event line = %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "data: ") {
		t.Fatalf("data line missing prefix: %q", lines[1])
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(lines[1], "data: ")), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload["phase"] != "loading" {
		t.Fatalf("phase field = %v", payload["phase"])
	}
	if seq, ok := payload["seq"].(float64); !ok || int(seq) != 1 {
		t.Fatalf("seq = %v (type %T), want 1", payload["seq"], payload["seq"])
	}
}

func TestSSEStreamerSequence(t *testing.T) {
	rec := httptest.NewRecorder()
	s, err := NewSSEStreamer(rec)
	if err != nil {
		t.Fatalf("NewSSEStreamer: %v", err)
	}

	for i := 0; i < 5; i++ {
		if err := s.Emit("phase", map[string]any{"i": i}); err != nil {
			t.Fatalf("Emit %d: %v", i, err)
		}
	}
	if s.Seq() != 5 {
		t.Fatalf("Seq() = %d, want 5", s.Seq())
	}

	body := rec.Body.String()
	frames := strings.Split(strings.TrimRight(body, "\n"), "\n\n")
	if len(frames) != 5 {
		t.Fatalf("want 5 frames, got %d", len(frames))
	}
	for i, frame := range frames {
		want := i + 1
		if !strings.Contains(frame, `"seq":`+itoa(want)) {
			t.Fatalf("frame %d missing seq=%d: %q", i, want, frame)
		}
	}
}

func TestSSEStreamerNonFlushable(t *testing.T) {
	_, err := NewSSEStreamer(&nonFlushRecorder{})
	if !errors.Is(err, ErrStreamerNotFlushable) {
		t.Fatalf("err = %v, want ErrStreamerNotFlushable", err)
	}
}

func TestSSEStreamerCloseEmitsEndComment(t *testing.T) {
	rec := httptest.NewRecorder()
	s, err := NewSSEStreamer(rec)
	if err != nil {
		t.Fatalf("NewSSEStreamer: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !strings.Contains(rec.Body.String(), ": end of stream") {
		t.Fatalf("Close should emit a colon-comment, got %q", rec.Body.String())
	}
}

func TestSSEStreamerNilPayload(t *testing.T) {
	rec := httptest.NewRecorder()
	s, err := NewSSEStreamer(rec)
	if err != nil {
		t.Fatalf("NewSSEStreamer: %v", err)
	}
	if err := s.Emit("done", nil); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"seq":1`) {
		t.Fatalf("seq missing in nil payload frame: %q", body)
	}
}

func TestSSEStreamerScalarPayloadFallsBackToValue(t *testing.T) {
	rec := httptest.NewRecorder()
	s, err := NewSSEStreamer(rec)
	if err != nil {
		t.Fatalf("NewSSEStreamer: %v", err)
	}
	if err := s.Emit("warning", "the quick brown fox"); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"value":"the quick brown fox"`) {
		t.Fatalf("scalar payload should be wrapped under value: %q", body)
	}
}

// itoa is a dependency-free integer formatter used to keep the test free of
// strconv noise inline.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

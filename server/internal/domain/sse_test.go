package domain

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestSSEEvent_JSONRoundTrip_PhaseStatus(t *testing.T) {
	t.Parallel()

	payload := AnalysisStatus{
		Phase:    PhaseParsing,
		Progress: 0.1,
		Message:  "scanning packages",
		Elapsed:  500 * time.Millisecond,
	}
	ev := SSEEvent{Type: EventPhase, Seq: 1, Payload: &payload}

	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// Decode into a typed envelope to verify the payload survives the trip.
	var decoded struct {
		Type    string         `json:"type"`
		Seq     int            `json:"seq"`
		Payload AnalysisStatus `json:"payload"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.Type != EventPhase || decoded.Seq != 1 {
		t.Fatalf("envelope mismatch: %+v", decoded)
	}
	if !reflect.DeepEqual(decoded.Payload, payload) {
		t.Fatalf("payload mismatch: %#v vs %#v", decoded.Payload, payload)
	}
}

func TestSSEEvent_GobRoundTrip_AnyPayload(t *testing.T) {
	t.Parallel()

	ev := SSEEvent{
		Type:    EventPhase,
		Seq:     7,
		Payload: AnalysisStatus{Phase: PhaseDone, Progress: 1.0},
	}
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(ev); err != nil {
		t.Fatalf("encode: %v", err)
	}
	var got SSEEvent
	if err := gob.NewDecoder(&buf).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Type != ev.Type || got.Seq != ev.Seq {
		t.Fatalf("envelope mismatch: %+v", got)
	}
	status, ok := got.Payload.(AnalysisStatus)
	if !ok {
		t.Fatalf("payload type after gob decode: %T", got.Payload)
	}
	if status.Phase != PhaseDone || status.Progress != 1.0 {
		t.Fatalf("payload content mismatch: %#v", status)
	}
}

func TestSSEEvent_KnownTypes(t *testing.T) {
	t.Parallel()

	want := map[string]string{
		"phase":         EventPhase,
		"partial_graph": EventPartialGraph,
		"warning":       EventWarning,
		"done":          EventDone,
	}
	for k, v := range want {
		if k != v {
			t.Fatalf("event constant mismatch for %q: %q", k, v)
		}
	}
}

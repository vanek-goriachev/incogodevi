package domain

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestAnalysisPhase_IsValid(t *testing.T) {
	t.Parallel()

	for _, p := range AllAnalysisPhases {
		p := p
		t.Run(string(p), func(t *testing.T) {
			t.Parallel()
			if !p.IsValid() {
				t.Fatalf("expected %q to be valid", p)
			}
		})
	}
	for _, bad := range []AnalysisPhase{"", "uploading", "BUILDING_GRAPH"} {
		bad := bad
		t.Run("invalid/"+string(bad), func(t *testing.T) {
			t.Parallel()
			if bad.IsValid() {
				t.Fatalf("expected %q to be invalid", bad)
			}
		})
	}
}

func TestAnalysisStatus_JSONRoundTrip(t *testing.T) {
	t.Parallel()

	s := AnalysisStatus{
		Phase:    PhaseBuildingGraph,
		Progress: 0.42,
		Message:  "halfway there",
		Elapsed:  3 * time.Second,
	}
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got AnalysisStatus
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(got, s) {
		t.Fatalf("round trip mismatch: %#v vs %#v", got, s)
	}
}

func TestAnalysisStatus_OmitsEmptyMessage(t *testing.T) {
	t.Parallel()

	s := AnalysisStatus{Phase: PhaseLoading, Progress: 0}
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(data) == "" || containsKey(data, "message") {
		t.Fatalf("expected message to be omitted, body=%s", data)
	}
}

func containsKey(buf []byte, key string) bool {
	needle := []byte(`"` + key + `"`)
	return indexOf(buf, needle) >= 0
}

func indexOf(haystack, needle []byte) int {
	if len(needle) == 0 || len(needle) > len(haystack) {
		return -1
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := range needle {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

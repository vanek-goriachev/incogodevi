package domain

import (
	"encoding/json"
	"testing"
)

func TestEdgeKind_IsValid(t *testing.T) {
	t.Parallel()

	for _, k := range AllEdgeKinds {
		k := k
		t.Run(string(k), func(t *testing.T) {
			t.Parallel()
			if !k.IsValid() {
				t.Fatalf("expected %q to be valid", k)
			}
		})
	}
	for _, bad := range []EdgeKind{"", "Imports", "uses", "depends_on"} {
		bad := bad
		t.Run("invalid/"+string(bad), func(t *testing.T) {
			t.Parallel()
			if bad.IsValid() {
				t.Fatalf("expected %q to be invalid", bad)
			}
		})
	}
}

func TestAllEdgeKinds_HasSixDistinct(t *testing.T) {
	t.Parallel()

	if got := len(AllEdgeKinds); got != 6 {
		t.Fatalf("AllEdgeKinds: want 6, got %d", got)
	}
	seen := make(map[EdgeKind]struct{}, len(AllEdgeKinds))
	for _, k := range AllEdgeKinds {
		seen[k] = struct{}{}
	}
	if len(seen) != 6 {
		t.Fatalf("AllEdgeKinds contains duplicates: %v", AllEdgeKinds)
	}
}

func TestEdgeID_KnownVectors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		source string
		target string
		kind   EdgeKind
		want   string
	}{
		{"calls aaaa->bbbb", "aaaa", "bbbb", EdgeKindCalls, "203de27c39b2ad7d"},
		{"imports aaaa->bbbb", "aaaa", "bbbb", EdgeKindImports, "8f21f4eb4119c5dc"},
		{"calls bbbb->aaaa", "bbbb", "aaaa", EdgeKindCalls, "2cf29419637c9939"},
		{"empty endpoints", "", "", EdgeKindContains, "ff1e9dc9010c2390"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := EdgeID(tc.source, tc.target, tc.kind)
			if got != tc.want {
				t.Fatalf("EdgeID(%q,%q,%q) = %q, want %q",
					tc.source, tc.target, tc.kind, got, tc.want)
			}
			if len(got) != 16 {
				t.Fatalf("EdgeID length = %d, want 16", len(got))
			}
		})
	}
}

func TestEdgeID_Deterministic(t *testing.T) {
	t.Parallel()

	a := EdgeID("s", "t", EdgeKindCalls)
	b := EdgeID("s", "t", EdgeKindCalls)
	if a != b {
		t.Fatalf("EdgeID not deterministic: %q vs %q", a, b)
	}
}

func TestEdgeID_DiffersOnDifferentInputs(t *testing.T) {
	t.Parallel()

	inputs := []struct {
		s, t string
		k    EdgeKind
	}{
		{"a", "b", EdgeKindCalls},
		{"a", "b", EdgeKindImports},
		{"b", "a", EdgeKindCalls},
		{"a", "c", EdgeKindCalls},
	}
	seen := make(map[string]struct{}, len(inputs))
	for _, in := range inputs {
		id := EdgeID(in.s, in.t, in.k)
		if _, dup := seen[id]; dup {
			t.Fatalf("collision on %+v -> %s", in, id)
		}
		seen[id] = struct{}{}
	}
}

func TestEdge_JSONRoundTrip(t *testing.T) {
	t.Parallel()

	e := Edge{
		ID:     EdgeID("src", "dst", EdgeKindCalls),
		Source: "src",
		Target: "dst",
		Kind:   EdgeKindCalls,
		Weight: 7,
	}
	data, err := json.Marshal(e)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got Edge
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got != e {
		t.Fatalf("round trip mismatch: %#v vs %#v", got, e)
	}
}

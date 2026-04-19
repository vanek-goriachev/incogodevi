package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNodeKind_IsValid(t *testing.T) {
	t.Parallel()

	for _, k := range AllNodeKinds {
		k := k
		t.Run(string(k), func(t *testing.T) {
			t.Parallel()
			if !k.IsValid() {
				t.Fatalf("expected %q to be valid", k)
			}
		})
	}
	for _, bad := range []NodeKind{"", "Package", "module", "type", "xxx"} {
		bad := bad
		t.Run("invalid/"+string(bad), func(t *testing.T) {
			t.Parallel()
			if bad.IsValid() {
				t.Fatalf("expected %q to be invalid", bad)
			}
		})
	}
}

func TestAllNodeKinds_HasEightDistinct(t *testing.T) {
	t.Parallel()

	if got := len(AllNodeKinds); got != 8 {
		t.Fatalf("AllNodeKinds: want 8, got %d", got)
	}
	seen := make(map[NodeKind]struct{}, len(AllNodeKinds))
	for _, k := range AllNodeKinds {
		seen[k] = struct{}{}
	}
	if len(seen) != 8 {
		t.Fatalf("AllNodeKinds contains duplicates: %v", AllNodeKinds)
	}
}

func TestNodeID_KnownVectors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		pkg    string
		typeNm string
		member string
		want   string
	}{
		{"package only", "github.com/acme/example/api", "", "", "3269fa207fb5e080"},
		{"struct", "github.com/acme/example/api", "Handler", "", "d41113854ad9fe77"},
		{"method", "github.com/acme/example/api", "Handler", "ServeHTTP", "867ebb894ca75e5c"},
		{"member without type", "github.com/acme/example/api", "", "GlobalCounter", "ac697ed73e176025"},
		{"empty package", "", "Handler", "ServeHTTP", "e14245d56c1aae75"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := NodeID(tc.pkg, tc.typeNm, tc.member)
			if got != tc.want {
				t.Fatalf("NodeID(%q,%q,%q) = %q, want %q",
					tc.pkg, tc.typeNm, tc.member, got, tc.want)
			}
			if len(got) != 16 {
				t.Fatalf("NodeID length = %d, want 16", len(got))
			}
		})
	}
}

func TestNodeID_Deterministic(t *testing.T) {
	t.Parallel()

	a := NodeID("a/b", "T", "M")
	b := NodeID("a/b", "T", "M")
	if a != b {
		t.Fatalf("NodeID not deterministic: %q vs %q", a, b)
	}
}

func TestNodeID_DiffersOnDifferentInputs(t *testing.T) {
	t.Parallel()

	inputs := [][3]string{
		{"a/b", "T", "M"},
		{"a/b", "T", "N"},
		{"a/b", "U", "M"},
		{"a/c", "T", "M"},
		{"a/b", "", "M"},
	}
	seen := make(map[string]struct{}, len(inputs))
	for _, in := range inputs {
		id := NodeID(in[0], in[1], in[2])
		if _, dup := seen[id]; dup {
			t.Fatalf("collision on %v -> %s", in, id)
		}
		seen[id] = struct{}{}
	}
}

func TestNode_JSONRoundTrip_OmitsZeroChildCount(t *testing.T) {
	t.Parallel()

	n := Node{
		ID:        NodeID("pkg", "T", ""),
		Name:      "T",
		Kind:      NodeKindStruct,
		Package:   "pkg",
		File:      "pkg/file.go",
		Line:      10,
		Exported:  true,
		Reachable: true,
		IsEntry:   false,
		Doc:       "T is a thing",
	}
	data, err := json.Marshal(n)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(data), "child_count") {
		t.Fatalf("zero ChildCount should be omitted, body=%s", data)
	}
	var got Node
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got != n {
		t.Fatalf("round trip mismatch: %#v vs %#v", got, n)
	}
}

func TestNode_JSONRoundTrip_EmitsPositiveChildCount(t *testing.T) {
	t.Parallel()

	n := Node{
		ID:         NodeID("pkg", "", ""),
		Name:       "pkg",
		Kind:       NodeKindPackage,
		Package:    "pkg",
		ChildCount: 42,
	}
	data, err := json.Marshal(n)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(data), `"child_count":42`) {
		t.Fatalf("expected child_count in JSON, body=%s", data)
	}
	var got Node
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got != n {
		t.Fatalf("round trip mismatch: %#v vs %#v", got, n)
	}
}

func TestNode_JSONRoundTrip_OmitsEmptyDoc(t *testing.T) {
	t.Parallel()

	n := Node{ID: "x", Name: "y", Kind: NodeKindFunc, Package: "p"}
	data, err := json.Marshal(n)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(data), `"doc"`) {
		t.Fatalf("expected doc to be omitted, body=%s", data)
	}
}

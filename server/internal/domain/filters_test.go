package domain

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestDefaultFilters(t *testing.T) {
	t.Parallel()

	f := DefaultFilters()
	if len(f.IncludeKinds) != len(AllNodeKinds) {
		t.Fatalf("IncludeKinds: got %d want %d", len(f.IncludeKinds), len(AllNodeKinds))
	}
	if !f.StdlibExclude || !f.TestExclude {
		t.Fatalf("expected stdlib_exclude and test_exclude to default to true: %#v", f)
	}
	if f.ExcludePaths == nil {
		t.Fatalf("ExcludePaths should be non-nil empty")
	}
}

func TestFilters_JSONRoundTrip(t *testing.T) {
	t.Parallel()

	f := Filters{
		IncludeKinds:  []NodeKind{NodeKindFunc, NodeKindMethod},
		ExcludePaths:  []string{"vendor/*"},
		StdlibExclude: true,
		TestExclude:   false,
	}
	data, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got Filters
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(got, f) {
		t.Fatalf("round trip mismatch: %#v vs %#v", got, f)
	}
}

func TestDefaultFilters_IsIndependentCopy(t *testing.T) {
	t.Parallel()

	a := DefaultFilters()
	b := DefaultFilters()
	a.IncludeKinds[0] = NodeKindConst
	if b.IncludeKinds[0] == NodeKindConst {
		t.Fatalf("DefaultFilters() shares underlying slice between calls")
	}
}

package domain

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestEntryPointMode_IsValid(t *testing.T) {
	t.Parallel()

	for _, m := range []EntryPointMode{EntryPointModeAuto, EntryPointModeManual, EntryPointModeMixed} {
		if !m.IsValid() {
			t.Fatalf("expected %q to be valid", m)
		}
	}
	for _, bad := range []EntryPointMode{"", "AUTO", "explicit"} {
		if bad.IsValid() {
			t.Fatalf("expected %q to be invalid", bad)
		}
	}
}

func TestDefaultEntryPointSpec(t *testing.T) {
	t.Parallel()

	spec := DefaultEntryPointSpec()
	if spec.Mode != EntryPointModeAuto {
		t.Fatalf("Mode: got %q want auto", spec.Mode)
	}
	if !reflect.DeepEqual(spec.AutoKinds, []string{"main"}) {
		t.Fatalf("AutoKinds: %v", spec.AutoKinds)
	}
	if spec.Manual == nil || len(spec.Manual) != 0 {
		t.Fatalf("Manual should be non-nil empty, got %#v", spec.Manual)
	}
	if spec.InterfaceImpl == nil || len(spec.InterfaceImpl) != 0 {
		t.Fatalf("InterfaceImpl should be non-nil empty, got %#v", spec.InterfaceImpl)
	}
}

func TestEntryPointSpec_JSONRoundTrip(t *testing.T) {
	t.Parallel()

	spec := EntryPointSpec{
		Mode:          EntryPointModeMixed,
		AutoKinds:     []string{"main", "init"},
		Manual:        []string{"example.com/api#Handler"},
		InterfaceImpl: []string{"example.com/store#Store"},
	}
	data, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got EntryPointSpec
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(got, spec) {
		t.Fatalf("round trip mismatch: %#v vs %#v", got, spec)
	}
}

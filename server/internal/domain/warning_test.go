package domain

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"reflect"
	"testing"
)

func TestWarning_JSONRoundTrip(t *testing.T) {
	t.Parallel()

	w := Warning{
		Code:    "import_error",
		Message: "package foo: missing",
		Package: "example.com/foo",
		File:    "foo/foo.go",
	}
	data, err := json.Marshal(w)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got Warning
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got != w {
		t.Fatalf("round trip mismatch: %#v vs %#v", got, w)
	}
}

func TestWarning_JSONOmitsEmptyOptionals(t *testing.T) {
	t.Parallel()

	w := Warning{Code: "x", Message: "y"}
	data, err := json.Marshal(w)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	got := string(data)
	if want := `{"code":"x","message":"y"}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestWarning_GobRoundTrip(t *testing.T) {
	t.Parallel()

	in := Warning{Code: "c", Message: "m", Package: "p", File: "f"}
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(in); err != nil {
		t.Fatalf("encode: %v", err)
	}
	var out Warning
	if err := gob.NewDecoder(&buf).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("mismatch: %#v vs %#v", in, out)
	}
}

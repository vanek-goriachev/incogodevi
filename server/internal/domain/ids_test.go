package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNewProjectID_ShapeAndUniqueness(t *testing.T) {
	t.Parallel()

	const samples = 32
	seen := make(map[ProjectID]struct{}, samples)
	for i := 0; i < samples; i++ {
		id := NewProjectID()
		if got := len(string(id)); got != 22 {
			t.Fatalf("NewProjectID length: want 22, got %d (%q)", got, id)
		}
		if !id.IsValid() {
			t.Fatalf("NewProjectID returned invalid ID %q", id)
		}
		if strings.Contains(string(id), "=") {
			t.Fatalf("NewProjectID returned padded value %q", id)
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("duplicate ProjectID %q after %d samples", id, i)
		}
		seen[id] = struct{}{}
	}
}

func TestProjectID_IsValid(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   ProjectID
		want bool
	}{
		{"happy", "hs3NwQ1jZCEtj8pKmXKg9g", true},
		{"too short", "abc", false},
		{"too long", "hs3NwQ1jZCEtj8pKmXKg9g0", false},
		{"padding", "hs3NwQ1jZCEtj8pKmXKg9=", false},
		{"empty", "", false},
		{"slash", "hs3NwQ1jZCEtj8pKmXKg9/", false},
		{"plus", "hs3NwQ1jZCEtj8pKmXKg9+", false},
		{"all underscores", "______________________", true},
		{"all dashes", "----------------------", true},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := tc.in.IsValid(); got != tc.want {
				t.Fatalf("IsValid(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestProjectID_TextRoundTrip(t *testing.T) {
	t.Parallel()

	original := NewProjectID()
	encoded, err := original.MarshalText()
	if err != nil {
		t.Fatalf("MarshalText: %v", err)
	}

	var decoded ProjectID
	if err := decoded.UnmarshalText(encoded); err != nil {
		t.Fatalf("UnmarshalText: %v", err)
	}
	if decoded != original {
		t.Fatalf("round trip mismatch: got %q want %q", decoded, original)
	}
}

func TestProjectID_MarshalText_RejectsInvalid(t *testing.T) {
	t.Parallel()

	bad := ProjectID("nope")
	if _, err := bad.MarshalText(); err == nil {
		t.Fatalf("MarshalText accepted invalid ID")
	}
}

func TestProjectID_UnmarshalText_RejectsInvalid(t *testing.T) {
	t.Parallel()

	cases := []string{"", "abc", strings.Repeat("a", 23), "??????????????????????"}
	for _, in := range cases {
		var p ProjectID
		if err := p.UnmarshalText([]byte(in)); err == nil {
			t.Fatalf("UnmarshalText accepted invalid input %q", in)
		}
	}
}

func TestProjectID_JSONRoundTrip(t *testing.T) {
	t.Parallel()

	type wrapper struct {
		ID ProjectID `json:"id"`
	}
	original := wrapper{ID: NewProjectID()}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded wrapper
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.ID != original.ID {
		t.Fatalf("JSON round trip mismatch: %q vs %q", decoded.ID, original.ID)
	}
}

func TestProjectID_String(t *testing.T) {
	t.Parallel()

	id := ProjectID("hs3NwQ1jZCEtj8pKmXKg9g")
	if id.String() != "hs3NwQ1jZCEtj8pKmXKg9g" {
		t.Fatalf("String(): %q", id.String())
	}
}

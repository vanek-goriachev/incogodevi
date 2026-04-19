package exporter_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/exporter"
)

// sampleReport returns a report with three entries listed in non-canonical
// order so the renderers must sort them deterministically.
func sampleReport() *domain.DeadCodeReport {
	return &domain.DeadCodeReport{
		ProjectID:   "AAAAAAAAAAAAAAAAAAAAAA",
		GeneratedAt: time.Date(2026, 4, 18, 12, 35, 4, 0, time.UTC),
		Entries: []domain.DeadCodeEntry{
			{
				Kind:    domain.NodeKindMethod,
				FQN:     "github.com/acme/example/store.MongoStore.Close",
				Package: "github.com/acme/example/store",
				Name:    "Close",
				File:    "store/mongo.go",
				Line:    128,
				Reason:  "unreachable",
			},
			{
				Kind:    domain.NodeKindFunc,
				FQN:     "github.com/acme/example/internal/util.OlderHelper",
				Package: "github.com/acme/example/internal/util",
				Name:    "OlderHelper",
				File:    "internal/util/helper.go",
				Line:    120,
				Reason:  "unreachable",
			},
			{
				Kind:    domain.NodeKindFunc,
				FQN:     "github.com/acme/example/internal/util.DeprecatedHelper",
				Package: "github.com/acme/example/internal/util",
				Name:    "DeprecatedHelper",
				File:    "internal/util/helper.go",
				Line:    42,
				Reason:  "unreachable",
			},
		},
		EntriesCount: 3,
	}
}

func TestRenderTXTGolden(t *testing.T) {
	t.Parallel()

	got := exporter.RenderTXT(sampleReport())
	want, err := os.ReadFile(filepath.Join("testdata", "dead-code.golden.txt"))
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("RenderTXT mismatch\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestRenderTXTEmptyReport(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		r    *domain.DeadCodeReport
	}{
		{"nil report", nil},
		{"zero entries", &domain.DeadCodeReport{Entries: nil}},
		{"empty slice", &domain.DeadCodeReport{Entries: []domain.DeadCodeEntry{}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			got := exporter.RenderTXT(c.r)
			if string(got) != "no dead code detected\n" {
				t.Errorf("got %q, want sentinel line", got)
			}
		})
	}
}

func TestRenderTXTLineEndings(t *testing.T) {
	t.Parallel()

	got := exporter.RenderTXT(sampleReport())
	for i, b := range got {
		if b == '\r' {
			t.Fatalf("CR byte at offset %d — TXT must use LF only", i)
		}
	}
	// FR-23: UTF-8 without BOM.
	if len(got) >= 3 && got[0] == 0xEF && got[1] == 0xBB && got[2] == 0xBF {
		t.Fatalf("output starts with UTF-8 BOM")
	}
	if got[len(got)-1] != '\n' {
		t.Fatalf("output must end with LF, got %q", got[len(got)-1])
	}
}

func TestRenderJSONRoundTrip(t *testing.T) {
	t.Parallel()

	original := sampleReport()
	raw, err := exporter.RenderJSON(original)
	if err != nil {
		t.Fatalf("RenderJSON: %v", err)
	}

	var decoded domain.DeadCodeReport
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.ProjectID != original.ProjectID {
		t.Errorf("project_id: got %q, want %q", decoded.ProjectID, original.ProjectID)
	}
	if !decoded.GeneratedAt.Equal(original.GeneratedAt) {
		t.Errorf("generated_at: got %v, want %v", decoded.GeneratedAt, original.GeneratedAt)
	}
	if decoded.EntriesCount != len(original.Entries) {
		t.Errorf("entries_count: got %d, want %d", decoded.EntriesCount, len(original.Entries))
	}
	if len(decoded.Entries) != len(original.Entries) {
		t.Fatalf("len(entries) = %d, want %d", len(decoded.Entries), len(original.Entries))
	}

	// First entry after sorting must be the lowest-line OlderHelper sibling.
	want := []string{"DeprecatedHelper", "OlderHelper", "Close"}
	got := []string{decoded.Entries[0].Name, decoded.Entries[1].Name, decoded.Entries[2].Name}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("entry order = %v, want %v", got, want)
	}
}

func TestRenderJSONEmptyEntries(t *testing.T) {
	t.Parallel()

	r := &domain.DeadCodeReport{
		ProjectID:    "AAAAAAAAAAAAAAAAAAAAAA",
		GeneratedAt:  time.Date(2026, 4, 18, 0, 0, 0, 0, time.UTC),
		Entries:      []domain.DeadCodeEntry{},
		EntriesCount: 0,
	}
	raw, err := exporter.RenderJSON(r)
	if err != nil {
		t.Fatalf("RenderJSON: %v", err)
	}

	var decoded domain.DeadCodeReport
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.EntriesCount != 0 {
		t.Errorf("entries_count = %d, want 0", decoded.EntriesCount)
	}
	if len(decoded.Entries) != 0 {
		t.Errorf("entries len = %d, want 0", len(decoded.Entries))
	}
	// Wire format must contain "entries":[] not "entries":null.
	if !strings.Contains(string(raw), `"entries":[]`) {
		t.Errorf("payload missing empty array marker: %s", raw)
	}
}

func TestRenderJSONNilReportIsAnError(t *testing.T) {
	t.Parallel()

	if _, err := exporter.RenderJSON(nil); err == nil {
		t.Errorf("nil report should return an error")
	}
}

func TestRenderJSONDoesNotMutateInput(t *testing.T) {
	t.Parallel()

	r := sampleReport()
	originalOrder := make([]string, len(r.Entries))
	for i, e := range r.Entries {
		originalOrder[i] = e.Name
	}
	if _, err := exporter.RenderJSON(r); err != nil {
		t.Fatalf("RenderJSON: %v", err)
	}
	for i, e := range r.Entries {
		if e.Name != originalOrder[i] {
			t.Errorf("input mutated at index %d: got %q, want %q", i, e.Name, originalOrder[i])
		}
	}
}

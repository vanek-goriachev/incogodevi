package exporter

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// emptyReportTXT is the FR-20 / FR-23 message returned when the report has no
// dead-code entries. The trailing newline is part of the contract.
const emptyReportTXT = "no dead code detected\n"

// RenderJSON serialises r as the JSON body documented in api-contract.md §4.
//
// Entries are emitted in deterministic order (Package → File → Line → FQN) so
// that diff-based caching layers and snapshot tests see byte-for-byte stability
// across runs. The function never returns an error in practice — json.Marshal
// of the report struct is total — but the signature mirrors json.Marshal so
// callers can propagate unexpected failures uniformly.
func RenderJSON(r *domain.DeadCodeReport) ([]byte, error) {
	if r == nil {
		return nil, errors.New("exporter: RenderJSON requires a non-nil report")
	}
	out := *r
	out.Entries = sortedEntries(r.Entries)
	if out.Entries == nil {
		// json.Marshal would emit "null" for a nil slice; the contract
		// (api-contract.md §4) requires "entries":[] for empty reports.
		out.Entries = []domain.DeadCodeEntry{}
	}
	out.EntriesCount = len(out.Entries)
	return json.Marshal(&out)
}

// RenderTXT serialises r as the line-oriented text format documented in
// api-contract.md §4 / FR-23. Each line follows the shape
//
//	<kind> <fqn> — <file>:<line>
//
// using LF terminators and UTF-8 without BOM. An empty report renders as
// "no dead code detected\n" per FR-20.
func RenderTXT(r *domain.DeadCodeReport) []byte {
	if r == nil || len(r.Entries) == 0 {
		return []byte(emptyReportTXT)
	}
	entries := sortedEntries(r.Entries)
	var buf bytes.Buffer
	buf.Grow(len(entries) * 80)
	for _, e := range entries {
		fmt.Fprintf(&buf, "%s %s — %s:%d\n", e.Kind, e.FQN, e.File, e.Line)
	}
	return buf.Bytes()
}

// sortedEntries returns a copy of in sorted by (Package, File, Line, FQN).
// The input is never mutated so callers can render the same report multiple
// times without worrying about ordering side-effects.
func sortedEntries(in []domain.DeadCodeEntry) []domain.DeadCodeEntry {
	if len(in) == 0 {
		return nil
	}
	out := make([]domain.DeadCodeEntry, len(in))
	copy(out, in)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Package != out[j].Package {
			return out[i].Package < out[j].Package
		}
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		if out[i].Line != out[j].Line {
			return out[i].Line < out[j].Line
		}
		return out[i].FQN < out[j].FQN
	})
	return out
}

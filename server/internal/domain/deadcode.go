package domain

import "time"

// DeadCodeEntry is one row in the dead-code report (FR-20, FR-23, FR-24).
//
// Reason is a short machine-readable token (e.g. "unreachable") rather than a
// human sentence; UI-side localisation lives in the frontend.
type DeadCodeEntry struct {
	Kind    NodeKind `json:"kind"`
	FQN     string   `json:"fqn"`
	Package string   `json:"package"`
	Name    string   `json:"name"`
	File    string   `json:"file"`
	Line    int      `json:"line"`
	Reason  string   `json:"reason"`
}

// DeadCodeReport is the JSON body returned by /api/projects/{id}/dead-code
// (api-contract.md §4).
type DeadCodeReport struct {
	ProjectID    ProjectID       `json:"project_id"`
	GeneratedAt  time.Time       `json:"generated_at"`
	EntriesCount int             `json:"entries_count"`
	Entries      []DeadCodeEntry `json:"entries"`
}

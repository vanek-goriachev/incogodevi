package domain

import (
	"crypto/sha1" // #nosec G505 -- stable identifier hash, not security-critical (ADR-07).
	"encoding/hex"
)

// EdgeKind enumerates the relationships between graph nodes (design.md §5.2).
type EdgeKind string

// Recognised EdgeKind values.
const (
	EdgeKindImports    EdgeKind = "imports"
	EdgeKindContains   EdgeKind = "contains"
	EdgeKindCalls      EdgeKind = "calls"
	EdgeKindEmbeds     EdgeKind = "embeds"
	EdgeKindImplements EdgeKind = "implements"
	EdgeKindReferences EdgeKind = "references"
)

// AllEdgeKinds lists every valid EdgeKind in declaration order.
var AllEdgeKinds = []EdgeKind{
	EdgeKindImports,
	EdgeKindContains,
	EdgeKindCalls,
	EdgeKindEmbeds,
	EdgeKindImplements,
	EdgeKindReferences,
}

// IsValid reports whether k is one of the recognised edge kinds.
func (k EdgeKind) IsValid() bool {
	switch k {
	case EdgeKindImports, EdgeKindContains, EdgeKindCalls,
		EdgeKindEmbeds, EdgeKindImplements, EdgeKindReferences:
		return true
	default:
		return false
	}
}

// Edge is a directed edge in the dependency graph.
type Edge struct {
	ID     string   `json:"id"`
	Source string   `json:"source"`
	Target string   `json:"target"`
	Kind   EdgeKind `json:"kind"`
	Weight int      `json:"weight"`
}

// EdgeID returns the stable identifier of an edge between two nodes.
//
// The canonical form is "<source>|<target>|<kind>"; the SHA-1 of that string is
// truncated to the first 16 hex characters (cf. ADR-07 for the same scheme on
// nodes). Equal inputs produce equal IDs; differing inputs produce differing
// IDs with negligible collision probability.
func EdgeID(source, target string, kind EdgeKind) string {
	canon := source + "|" + target + "|" + string(kind)
	sum := sha1.Sum([]byte(canon)) // #nosec G401 -- identifier hash.
	return hex.EncodeToString(sum[:])[:16]
}

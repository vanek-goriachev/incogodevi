package domain

import (
	"crypto/sha1" // #nosec G505 -- SHA-1 here is a stable identifier hash, not a security primitive (ADR-07).
	"encoding/hex"
)

// NodeKind enumerates the kinds of graph nodes the analyser produces.
//
// The set is closed and matches docs/design.md §5.1.
type NodeKind string

// Recognised NodeKind values.
const (
	NodeKindPackage   NodeKind = "package"
	NodeKindStruct    NodeKind = "struct"
	NodeKindInterface NodeKind = "interface"
	NodeKindFunc      NodeKind = "func"
	NodeKindMethod    NodeKind = "method"
	NodeKindField     NodeKind = "field"
	NodeKindVar       NodeKind = "var"
	NodeKindConst     NodeKind = "const"
)

// AllNodeKinds lists every valid NodeKind in declaration order.
var AllNodeKinds = []NodeKind{
	NodeKindPackage,
	NodeKindStruct,
	NodeKindInterface,
	NodeKindFunc,
	NodeKindMethod,
	NodeKindField,
	NodeKindVar,
	NodeKindConst,
}

// IsValid reports whether k is one of the eight kinds defined in design.md.
func (k NodeKind) IsValid() bool {
	switch k {
	case NodeKindPackage, NodeKindStruct, NodeKindInterface,
		NodeKindFunc, NodeKindMethod, NodeKindField,
		NodeKindVar, NodeKindConst:
		return true
	default:
		return false
	}
}

// Node is a vertex in the dependency graph.
//
// Field names on the wire are snake_case (api-contract.md §3). ChildCount is
// only emitted when greater than zero; it is populated for package-aggregated
// nodes (see ADR-06) and remains zero for ordinary nodes.
type Node struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Kind       NodeKind `json:"kind"`
	Package    string   `json:"package"`
	File       string   `json:"file"`
	Line       int      `json:"line"`
	Exported   bool     `json:"exported"`
	Reachable  bool     `json:"reachable"`
	IsEntry    bool     `json:"is_entry"`
	Doc        string   `json:"doc,omitempty"`
	ChildCount int      `json:"child_count,omitempty"`
	// External is true when the node belongs to a package outside the user's
	// main module (stdlib or third-party deps loaded transitively via
	// packages.Load NeedDeps). The frontend uses this to optionally hide
	// such nodes and to short-circuit "expand" actions that would otherwise
	// hit the scopeGraph endpoint and return an empty result.
	External bool `json:"external,omitempty"`
	// DeadCount and PartialDead/FullyDead are populated only on aggregated
	// package nodes (R4-5). The FE uses them to render packages where some
	// (but not all) members are dead with a distinct visual style instead of
	// treating them like fully-dead packages.
	DeadCount   int  `json:"dead_count,omitempty"`
	PartialDead bool `json:"partial_dead,omitempty"`
	FullyDead   bool `json:"fully_dead,omitempty"`
}

// NodeID returns the stable identifier of a node, derived from its canonical
// fully-qualified name as described by ADR-07.
//
// Canonical form: "<pkg>", "<pkg>#<Type>" or "<pkg>#<Type>.<Member>". When the
// type is empty the member is appended directly after the package, separated by
// ".". The result is the lowercase hex of the first 16 characters (8 bytes) of
// the SHA-1 digest.
func NodeID(pkg, typeName, member string) string {
	canon := pkg
	if typeName != "" {
		canon += "#" + typeName
	}
	if member != "" {
		canon += "." + member
	}
	sum := sha1.Sum([]byte(canon)) // #nosec G401 -- identifier hash, ADR-07.
	return hex.EncodeToString(sum[:])[:16]
}

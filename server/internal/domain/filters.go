package domain

// Filters narrows the visible part of the graph (api-contract.md §2).
//
// IncludeKinds restricts which NodeKinds are kept; an empty slice means «all
// kinds». ExcludePaths is a list of glob-style patterns (matched against the
// package import path) that the GraphBuilder will drop. StdlibExclude and
// TestExclude default to true in the API layer.
type Filters struct {
	IncludeKinds  []NodeKind `json:"include_kinds"`
	ExcludePaths  []string   `json:"exclude_paths"`
	StdlibExclude bool       `json:"stdlib_exclude"`
	TestExclude   bool       `json:"test_exclude"`
}

// DefaultFilters returns the filter set applied when /analyze is called with
// an empty body (api-contract.md §2). All eight NodeKinds are included; the
// stdlib and tests are hidden by default.
func DefaultFilters() Filters {
	include := make([]NodeKind, len(AllNodeKinds))
	copy(include, AllNodeKinds)
	return Filters{
		IncludeKinds:  include,
		ExcludePaths:  []string{},
		StdlibExclude: true,
		TestExclude:   true,
	}
}

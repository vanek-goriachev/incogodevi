package domain

// EntryPointMode controls how the EntryPointsResolver picks the seed set for
// the reachability traversal (api-contract.md §2).
type EntryPointMode string

// Recognised EntryPointMode values.
const (
	EntryPointModeAuto   EntryPointMode = "auto"
	EntryPointModeManual EntryPointMode = "manual"
	EntryPointModeMixed  EntryPointMode = "mixed"
)

// IsValid reports whether m is one of the three supported modes.
func (m EntryPointMode) IsValid() bool {
	switch m {
	case EntryPointModeAuto, EntryPointModeManual, EntryPointModeMixed:
		return true
	default:
		return false
	}
}

// EntryPointSpec describes the seed set for reachability analysis.
//
// Manual entries are canonical FQNs of the form "<pkg>#<Type>" or
// "<pkg>#<Type>.<Member>". InterfaceImpl entries name interfaces whose
// implementations should also be promoted to entry points.
type EntryPointSpec struct {
	Mode          EntryPointMode `json:"mode"`
	AutoKinds     []string       `json:"auto_kinds"`
	Manual        []string       `json:"manual"`
	InterfaceImpl []string       `json:"interface_impl"`
}

// DefaultEntryPointSpec returns the spec applied when /analyze is called with
// an empty body (api-contract.md §2). Slices are non-nil so the value
// round-trips through JSON unchanged.
func DefaultEntryPointSpec() EntryPointSpec {
	return EntryPointSpec{
		Mode:          EntryPointModeAuto,
		AutoKinds:     []string{"main"},
		Manual:        []string{},
		InterfaceImpl: []string{},
	}
}

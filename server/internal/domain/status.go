package domain

import "time"

// AnalysisPhase enumerates the lifecycle stages of an analysis run as emitted
// over SSE (api-contract.md §2).
type AnalysisPhase string

// Recognised AnalysisPhase values.
const (
	PhaseLoading       AnalysisPhase = "loading"
	PhaseParsing       AnalysisPhase = "parsing"
	PhaseBuildingGraph AnalysisPhase = "building_graph"
	PhaseReachability  AnalysisPhase = "reachability"
	PhaseExporting     AnalysisPhase = "exporting"
	PhaseDone          AnalysisPhase = "done"
	PhaseFailed        AnalysisPhase = "failed"
)

// AllAnalysisPhases lists every valid AnalysisPhase in pipeline order.
var AllAnalysisPhases = []AnalysisPhase{
	PhaseLoading,
	PhaseParsing,
	PhaseBuildingGraph,
	PhaseReachability,
	PhaseExporting,
	PhaseDone,
	PhaseFailed,
}

// IsValid reports whether p is one of the recognised phase strings.
func (p AnalysisPhase) IsValid() bool {
	switch p {
	case PhaseLoading, PhaseParsing, PhaseBuildingGraph,
		PhaseReachability, PhaseExporting, PhaseDone, PhaseFailed:
		return true
	default:
		return false
	}
}

// AnalysisStatus is the periodic progress report attached to SSE phase events
// and to the in-memory project state.
//
// Progress is in [0.0, 1.0]; Elapsed is encoded as nanoseconds, matching the
// default time.Duration JSON representation.
type AnalysisStatus struct {
	Phase    AnalysisPhase `json:"phase"`
	Progress float64       `json:"progress"`
	Message  string        `json:"message,omitempty"`
	Elapsed  time.Duration `json:"elapsed"`
}

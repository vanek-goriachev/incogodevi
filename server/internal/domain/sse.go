package domain

// SSE event type names emitted by /api/projects/{id}/analyze
// (api-contract.md §2). The set is open: clients must ignore unknown values.
const (
	EventPhase        = "phase"
	EventPartialGraph = "partial_graph"
	EventWarning      = "warning"
	EventDone         = "done"
)

// SSEEvent is the wire envelope for a single Server-Sent Event.
//
// Seq is monotonically increasing per connection (starts at 1) and is intended
// to support possible client-side resume. Payload is event-type specific; the
// SSE writer JSON-encodes it inline next to seq inside the data: frame.
type SSEEvent struct {
	Type    string `json:"type"`
	Seq     int    `json:"seq"`
	Payload any    `json:"payload"`
}

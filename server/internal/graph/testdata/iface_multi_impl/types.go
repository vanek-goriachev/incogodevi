// Package multi mirrors the FR-09 acceptance scenario: one interface with two
// implementations. The resolver must produce two implements-edges; whether
// either implementation is reachable is the reachability analyzer's concern
// (T11).
package multi

// Speaker is the contract under test.
type Speaker interface {
	Speak() string
}

// Loud satisfies Speaker via a value receiver.
type Loud struct{}

// Speak returns the loud greeting.
func (Loud) Speak() string { return "HELLO" }

// Quiet satisfies Speaker via a pointer receiver.
type Quiet struct{}

// Speak returns the quiet greeting.
func (q *Quiet) Speak() string { return "...hello" }

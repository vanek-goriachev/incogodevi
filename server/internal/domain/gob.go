package domain

import "encoding/gob"

// init registers every concrete type that may travel through an interface{}
// field (notably SSEEvent.Payload and the upcoming reduced parsed.gob snapshot
// from T07). Registration is required so encoding/gob can preserve dynamic
// types across the wire.
func init() {
	gob.Register(Node{})
	gob.Register(Edge{})
	gob.Register(Graph{})
	gob.Register(GraphStats{})
	gob.Register(Warning{})
	gob.Register(AnalysisStatus{})
	gob.Register(DeadCodeEntry{})
	gob.Register(DeadCodeReport{})
	gob.Register(EntryPointSpec{})
	gob.Register(Filters{})
	gob.Register([]Node(nil))
	gob.Register([]Edge(nil))
	gob.Register([]Warning(nil))
}

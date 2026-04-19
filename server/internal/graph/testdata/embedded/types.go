// Package embedded exercises struct and interface embedding for the graph
// builder tests.
package embedded

// Inner is the embedded leaf. It carries one method to verify that
// embedding-by-pointer and embedding-by-value resolve to the same node.
type Inner struct {
	Tag string
}

// Hello returns the embedded tag.
func (i Inner) Hello() string { return "hi " + i.Tag }

// Outer embeds Inner directly.
type Outer struct {
	Inner
	Extra int
}

// Reader is a minimal interface used to verify interface embedding.
type Reader interface {
	Read() string
}

// SuperReader embeds Reader to inherit its method set.
type SuperReader interface {
	Reader
	Close() error
}

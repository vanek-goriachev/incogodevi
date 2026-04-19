// Package withstruct exercises struct nodes, field nodes and method
// containment for the graph builder tests.
package withstruct

// Box bundles two fields and exposes a couple of methods.
type Box struct {
	Width  int
	Height int
}

// Area returns the area of the Box.
func (b Box) Area() int { return b.Width * b.Height }

// Scale multiplies both dimensions by k in place.
func (b *Box) Scale(k int) { b.Width *= k; b.Height *= k }

// Package empty verifies that the resolver does not flood the graph with
// edges to method-less interfaces such as `any`.
package empty

// Anything is an empty interface that must not produce any implements-edges.
type Anything interface{}

// First and Second both trivially satisfy Anything but the resolver must
// skip Anything outright because of its empty method set.
type First struct{}

// Hello returns a placeholder so First has a non-empty method set, but the
// method has no relation to any project interface.
func (First) Hello() string { return "hi" }

// Second has a different method to keep the two structs distinct.
type Second struct{}

// Bye is unrelated to any interface in the package.
func (Second) Bye() string { return "bye" }

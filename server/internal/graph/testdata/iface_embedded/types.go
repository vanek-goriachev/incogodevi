// Package embed exercises the implements resolver against embedded
// implementations. Outer should satisfy Worker because Inner does.
package embed

// Worker is the contract under test.
type Worker interface {
	Work() error
}

// Inner provides the actual Work method, declared with a pointer receiver to
// verify the resolver wraps T in types.NewPointer before consulting
// types.Implements.
type Inner struct {
	Name string
}

// Work satisfies Worker.
func (i *Inner) Work() error { return nil }

// Outer embeds Inner; its method set therefore includes Work and Outer must
// be reported as a Worker implementation.
type Outer struct {
	*Inner
	Counter int
}

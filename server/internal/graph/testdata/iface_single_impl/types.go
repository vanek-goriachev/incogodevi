// Package single exercises a one-interface, one-implementation case for the
// implements resolver tests.
package single

// Greeter is implemented by anything that knows how to say hello.
type Greeter interface {
	Greet() string
}

// EnglishGreeter satisfies Greeter via a value receiver.
type EnglishGreeter struct{}

// Greet returns the canonical English greeting.
func (EnglishGreeter) Greet() string { return "hello" }

// FrenchGreeter satisfies Greeter via a pointer receiver, exercising the
// types.NewPointer wrapping inside the resolver.
type FrenchGreeter struct{}

// Greet returns the canonical French greeting.
func (g *FrenchGreeter) Greet() string { return "bonjour" }

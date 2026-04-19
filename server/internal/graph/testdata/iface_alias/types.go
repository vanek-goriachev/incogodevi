// Package alias exercises the resolver's handling of Go 1.22 type aliases.
// AliasGreeter is an alias to Concrete; both must satisfy Greeter.
package alias

// Greeter is the interface under test.
type Greeter interface {
	Greet() string
}

// Concrete satisfies Greeter directly.
type Concrete struct{}

// Greet returns a fixed greeting.
func (Concrete) Greet() string { return "hi" }

// AliasGreeter is a transparent alias for Concrete. The resolver must unwrap
// it via types.Unalias and still emit an implements-edge.
type AliasGreeter = Concrete

// Package animal exposes a small interface hierarchy used by interface
// resolver integration tests.
package animal

// Speaker is implemented by anything that can produce a sound.
type Speaker interface {
	Speak() string
}

// Dog satisfies Speaker via a value receiver.
type Dog struct {
	Name string
}

// Speak returns the canonical dog sound.
func (d Dog) Speak() string { return "woof" }

// Cat satisfies Speaker via a pointer receiver.
type Cat struct {
	Name string
}

// Speak returns the canonical cat sound.
func (c *Cat) Speak() string { return "meow" }

// Closer is a second project-local interface used to verify the cartesian
// pairing in the resolver. Only Dog satisfies it (Cat does not declare
// Close).
type Closer interface {
	Close() error
}

// Close lets Dog satisfy Closer. The body is irrelevant to the resolver.
func (d Dog) Close() error { return nil }

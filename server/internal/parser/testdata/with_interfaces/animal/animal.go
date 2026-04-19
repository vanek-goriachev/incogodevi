// Package animal exposes a small interface hierarchy used by parser tests.
package animal

// Speaker is implemented by any type that can produce a sound.
type Speaker interface {
	Speak() string
}

// Dog is a concrete Speaker.
type Dog struct {
	Name string
}

// Speak satisfies Speaker.
func (d Dog) Speak() string { return "woof" }

// Cat is another concrete Speaker.
type Cat struct {
	Name string
}

// Speak satisfies Speaker via pointer receiver.
func (c *Cat) Speak() string { return "meow" }

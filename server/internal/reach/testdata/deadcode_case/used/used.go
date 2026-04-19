// Package used contains every symbol that the entry point reaches directly
// or via the contains-back-edge through Greeter.
package used

// Greeter wraps a salutation and is reachable through Greet calling its
// Hello method.
type Greeter struct {
	Salutation string
}

// Hello renders the greeting; reachable from app.Run -> Greet -> Greeter.Hello.
func (g Greeter) Hello(name string) string {
	return g.Salutation + ", " + name
}

// Greet allocates a Greeter and produces a greeting. Reached directly by
// app.Run.
func Greet(name string) string {
	g := Greeter{Salutation: "hi"}
	return g.Hello(name)
}

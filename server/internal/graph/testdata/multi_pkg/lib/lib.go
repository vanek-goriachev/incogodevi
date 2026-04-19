// Package lib supplies a constant, a variable and a helper for the multi
// package fixture.
package lib

// Pi is a package-level constant referenced from sibling packages.
const Pi = 3.14

// Counter is a package-level variable referenced from sibling packages.
var Counter int

// Bump increments Counter and returns its new value.
func Bump() int {
	Counter++
	return Counter
}

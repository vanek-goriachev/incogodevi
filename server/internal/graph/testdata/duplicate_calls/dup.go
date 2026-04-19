// Package dup verifies that duplicate call expressions collapse into a
// single edge with an incremented Weight.
package dup

// Target is invoked twice from Caller below.
func Target() int { return 7 }

// Caller calls Target twice in a row.
func Caller() int {
	return Target() + Target()
}

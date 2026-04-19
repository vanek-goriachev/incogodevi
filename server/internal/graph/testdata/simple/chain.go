// Package simple is a graph-builder fixture exercising a linear A->B->C call
// chain inside a single package.
package simple

// A is the entry of the chain. It calls B exactly once.
func A() int { return B() + 1 }

// B is the middle of the chain. It calls C exactly once.
func B() int { return C() * 2 }

// C is the tail of the chain. It calls nothing.
func C() int { return 42 }

// Package ok is a healthy sibling of the broken main package.
package ok

// Add is a tiny pure helper used to verify that healthy packages still parse
// when a sibling fails to resolve its imports.
func Add(a, b int) int { return a + b }

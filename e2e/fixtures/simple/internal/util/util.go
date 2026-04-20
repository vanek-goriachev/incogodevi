// Package util holds reachable helpers used by cmd/app.
package util

import "fmt"

// Greet returns a friendly greeting. Reachable from cmd/app.main.
func Greet(name string) string {
	return fmt.Sprintf("hello, %s", name)
}

// FormatBanner builds a banner string. Reachable from Greet via not-called
// helpers in real life, kept here as an extra reachable symbol.
func FormatBanner(title string) string {
	return fmt.Sprintf("== %s ==", title)
}

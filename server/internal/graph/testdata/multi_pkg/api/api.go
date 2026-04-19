// Package api consumes lib to exercise cross-package imports/calls/references.
package api

import "example.com/multi/lib"

// Label is a package-level constant referenced from Run.
const Label = "api"

// Run reads from lib to produce edges of every supported kind.
func Run() float64 {
	_ = lib.Bump()
	return lib.Pi + float64(len(Label))
}

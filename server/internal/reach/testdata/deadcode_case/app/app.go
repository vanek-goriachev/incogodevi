// Package app holds the entry-point Run that exercises one branch of the
// project. Anything not transitively reachable from Run is expected to land
// in the dead-code report.
package app

import "example.com/deadcase/used"

// Run is the manual entry point used by TestFR19Acceptance.
func Run() string {
	return used.Greet("world")
}

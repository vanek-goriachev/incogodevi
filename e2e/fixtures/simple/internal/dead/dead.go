// Package dead contains intentionally unreachable symbols so the E2E suite
// can assert dead-code highlighting and report export.
package dead

// LegacyAdder is unreachable from cmd/app.main and should appear in the
// dead-code report.
func LegacyAdder(a, b int) int {
	return a + b
}

// LegacyMultiplier is also unreachable. Kept distinct so the report has at
// least two named entries.
func LegacyMultiplier(a, b int) int {
	return a * b
}

// UnusedConst is exported but never referenced.
const UnusedConst = "legacy"

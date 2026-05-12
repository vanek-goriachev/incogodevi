// Package dead is intentionally never imported so its symbols surface in
// the dead-code report.
package dead

// NeverCalled is the canary symbol that exercises FR-15 (dead-code report).
func NeverCalled() string { return "dead" }

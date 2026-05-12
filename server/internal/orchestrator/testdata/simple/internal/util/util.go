// Package util provides small string helpers used by the simple test fixture.
package util

import "fmt"

// Greeting captures the formatted line returned by Greet.
type Greeting struct {
	Subject string
	Message string
}

// Greet renders a friendly hello for who.
func Greet(who string) string {
	g := Greeting{Subject: who, Message: fmt.Sprintf("hello %s", who)}
	return g.Message
}

// UnusedHelper has no callers but lives in a package that is imported by main,
// so the bidirectional contains traversal still keeps it reachable. The
// internal/dead package is the actual canary for the dead-code report.
func UnusedHelper() string { return "unused" }

// internalCounter is unexported and exists to verify scope filtering.
var internalCounter int

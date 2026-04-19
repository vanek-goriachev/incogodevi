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

// internalCounter is unexported and exists to verify scope filtering.
var internalCounter int

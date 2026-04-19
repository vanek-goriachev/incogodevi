// Package dead is a deliberately orphan package: no one imports it and Run
// never calls into it. Every export here is expected in the dead-code report.
package dead

// Lonely is an unused free function.
func Lonely() string {
	return helper()
}

// helper is internal but still unreachable because Lonely itself is dead.
func helper() string {
	return "nope"
}

// Unused is an exported variable nobody touches.
var Unused = 42

// Forgotten is a struct whose method is not invoked anywhere.
type Forgotten struct {
	Name string
}

// Whisper is a method on the orphan Forgotten struct.
func (f Forgotten) Whisper() string {
	return "shh " + f.Name
}

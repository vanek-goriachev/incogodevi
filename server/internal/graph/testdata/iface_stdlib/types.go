// Package stdlib has a type whose method signature satisfies io.Reader. The
// resolver must not emit an implements-edge to io.Reader because the
// interface lives in the standard library, not the project.
package stdlib

// Echo declares a Read method whose signature matches io.Reader. The
// resolver should still skip the io.Reader interface because it is owned
// by a non-project package.
type Echo struct{}

// Read populates p with a constant byte. The body is irrelevant to the
// resolver; what matters is that the method signature matches io.Reader.
func (Echo) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	p[0] = '!'
	return 1, nil
}

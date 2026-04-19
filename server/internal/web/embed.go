// Package web embeds the React/Cytoscape SPA shipped inside the server
// binary.
//
// At T12 the embedded tree contains only a placeholder index.html so the HTTP
// layer has something to serve while the real frontend is still being built
// (T17–T24). The Dockerfile in T25 copies the production build of web/dist
// into server/internal/web/dist before compiling, replacing the placeholder.
package web

import (
	"embed"
	"io/fs"
)

// distFS embeds the on-disk dist tree. The all: prefix ensures dotfiles such
// as .gitkeep are included even though Go's default embed pattern excludes
// them.
//
//go:embed all:dist
var distFS embed.FS

// DistFS exposes the embedded SPA bundle as an io/fs.FS rooted at the
// directory that index.html lives in. http.FileServerFS can be wrapped
// around the result directly.
func DistFS() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		// fs.Sub only fails when the supplied path is invalid; the embedded
		// tree always contains a "dist" entry, so this is unreachable in a
		// correctly built binary.
		panic("web: embedded dist directory missing: " + err.Error())
	}
	return sub
}

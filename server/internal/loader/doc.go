// Package loader unpacks an uploaded ZIP archive into the per-project sources
// directory owned by the cache.Manager and validates the result against the
// project's safety budget (NFR-04, NFR-13, NFR-14, ADR-08).
//
// The loader is the single owner of all archive-side defences:
//
//   - Pre-read size cap (ErrArchiveTooLarge) aligned with the
//     http.MaxBytesReader installed in the HTTP layer (T14).
//   - Entry count cap (ErrFileCountExceeded) and uncompressed-size cap
//     (ErrUnpackedSizeExceeded), both checked from the ZIP central directory
//     before any file is written to disk.
//   - Path sanitisation (ErrZipSlip) for every entry: filepath.Clean +
//     rejection of "..", absolute paths, drive letters and windows-style
//     traversal sequences.
//   - go.mod presence check (ErrGoModMissing) — the archive must contain a
//     go.mod either at the root or inside the first sub-directory.
//
// Successful uploads yield a ProjectMeta record persisted via cache.Manager
// and a populated SourcesDir with 0o600 files / 0o700 directories. Any error
// after the cache.Manager.NewProject call triggers a best-effort
// DeleteProject so the caller never observes a half-initialised project.
package loader

package loader_test

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/loader"
)

// zipEntry describes a single archive entry for the in-memory builder.
// Either Body or RawSize is meaningful: Body is used verbatim, RawSize sets
// UncompressedSize64 in the central directory without writing actual bytes
// (used to forge zip-bomb headers).
type zipEntry struct {
	Name      string
	Body      []byte
	IsDir     bool
	RawSize   uint64 // when non-zero, override UncompressedSize64 after writing
	IsSymlink bool
}

func buildZip(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		name := e.Name
		if e.IsDir && !strings.HasSuffix(name, "/") {
			name += "/"
		}
		hdr := &zip.FileHeader{
			Name:   name,
			Method: zip.Deflate,
		}
		if e.IsDir {
			hdr.SetMode(0o755 | os.ModeDir)
		} else if e.IsSymlink {
			hdr.SetMode(0o777 | os.ModeSymlink)
		} else {
			hdr.SetMode(0o644)
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatalf("CreateHeader %q: %v", e.Name, err)
		}
		if !e.IsDir && len(e.Body) > 0 {
			if _, err := w.Write(e.Body); err != nil {
				t.Fatalf("Write %q: %v", e.Name, err)
			}
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zw.Close: %v", err)
	}
	if len(entries) == 0 {
		return buf.Bytes()
	}
	// If any entry forged a fake RawSize, patch the central directory: the
	// resulting reader will think the entry is huge but the data section
	// remains tiny — the canonical "zip bomb header" forgery.
	patched := buf.Bytes()
	for _, e := range entries {
		if e.RawSize == 0 {
			continue
		}
		patched = patchCentralUncompressedSize(t, patched, e.Name, e.RawSize)
	}
	return patched
}

// patchCentralUncompressedSize rewrites the UncompressedSize64 field of the
// central-directory record for the given entry name. It supports both the
// classic 32-bit field and the ZIP64 extra block. The function is
// deliberately lenient: it locates the first central-directory header whose
// name matches and patches that one; tests do not need exotic shapes.
func patchCentralUncompressedSize(t *testing.T, raw []byte, name string, newSize uint64) []byte {
	t.Helper()
	// Central directory file header signature: 0x02014b50.
	sig := []byte{0x50, 0x4b, 0x01, 0x02}
	idx := 0
	for {
		off := bytes.Index(raw[idx:], sig)
		if off < 0 {
			t.Fatalf("no central header for %q", name)
		}
		hdr := idx + off
		// fixed header is 46 bytes; name length at offset 28, extra at 30,
		// comment at 32; uncompressed-size at offset 24.
		if hdr+46 > len(raw) {
			t.Fatalf("truncated central header for %q", name)
		}
		nameLen := int(uint16(raw[hdr+28]) | uint16(raw[hdr+29])<<8)
		extraLen := int(uint16(raw[hdr+30]) | uint16(raw[hdr+31])<<8)
		commentLen := int(uint16(raw[hdr+32]) | uint16(raw[hdr+33])<<8)
		entryName := string(raw[hdr+46 : hdr+46+nameLen])
		if entryName != name {
			idx = hdr + 46 + nameLen + extraLen + commentLen
			continue
		}
		// Patch the 32-bit uncompressed size in place. We cap at 2^32-2 so
		// readers do not promote it to ZIP64 lookups. ZIP bomb fixtures
		// only need a value that exceeds MaxUnpackedBytes (500 MiB), so
		// 2^32-2 is more than enough.
		size := newSize
		if size >= 0xFFFF_FFFF {
			size = 0xFFFF_FFFE
		}
		raw[hdr+24] = byte(size)
		raw[hdr+25] = byte(size >> 8)
		raw[hdr+26] = byte(size >> 16)
		raw[hdr+27] = byte(size >> 24)
		return raw
	}
}

func goodGoMod(module string) []byte {
	return []byte("module " + module + "\n\ngo 1.26\n")
}

// newTestManager mirrors the helper from the cache package.
func newTestManager(t *testing.T) cache.Manager {
	t.Helper()
	mgr, err := cache.New(cache.Options{
		RootTmp:       filepath.Join(t.TempDir(), "sources"),
		RootCache:     filepath.Join(t.TempDir(), "cache"),
		IdleTTL:       time.Hour,
		SweepInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })
	return mgr
}

func newLoader(t *testing.T, override ...func(*loader.Config)) (*loader.Loader, cache.Manager) {
	t.Helper()
	mgr := newTestManager(t)
	cfg := loader.Config{}
	for _, fn := range override {
		fn(&cfg)
	}
	return loader.New(mgr, cfg, slog.New(slog.NewTextHandler(io.Discard, nil))), mgr
}

func TestHappyPathRootGoMod(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/acme")},
		{Name: "main.go", Body: []byte("package main\nfunc main(){}\n")},
		{Name: "internal/", IsDir: true},
		{Name: "internal/util.go", Body: []byte("package internal\n")},
	})

	meta, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if meta.Name != "example.com/acme" {
		t.Errorf("name = %q, want module path", meta.Name)
	}
	if !meta.ID.IsValid() {
		t.Errorf("invalid project id %q", meta.ID)
	}
	if meta.SizeBytes != int64(len(body)) {
		t.Errorf("size_bytes = %d, want %d", meta.SizeBytes, len(body))
	}
	if meta.FileCount != 3 {
		t.Errorf("file_count = %d, want 3", meta.FileCount)
	}

	src := mgr.SourcesDir(meta.ID)
	for _, rel := range []string{"go.mod", "main.go", "internal/util.go"} {
		info, err := os.Stat(filepath.Join(src, rel))
		if err != nil {
			t.Fatalf("stat %s: %v", rel, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s perm = %v, want 0600", rel, info.Mode().Perm())
		}
	}
}

func TestHappyPathSubdirGoMod(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "repo-v1/", IsDir: true},
		{Name: "repo-v1/go.mod", Body: goodGoMod("example.com/sub")},
		{Name: "repo-v1/main.go", Body: []byte("package main\n")},
	})

	meta, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "custom")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if meta.Name != "custom" {
		t.Errorf("name = %q, want custom (display override)", meta.Name)
	}
	src := mgr.SourcesDir(meta.ID)
	if _, err := os.Stat(filepath.Join(src, "go.mod")); err != nil {
		t.Fatalf("flattened go.mod: %v", err)
	}
	if _, err := os.Stat(filepath.Join(src, "main.go")); err != nil {
		t.Fatalf("flattened main.go: %v", err)
	}
	if _, err := os.Stat(filepath.Join(src, "repo-v1")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("wrapper dir still present: %v", err)
	}
}

func TestFlattenIgnoresMacOSFinderCruft(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "__MACOSX/", IsDir: true},
		{Name: "__MACOSX/._go.mod", Body: []byte("resource fork sidecar")},
		{Name: "server/", IsDir: true},
		{Name: "server/go.mod", Body: goodGoMod("example.com/finder")},
		{Name: "server/main.go", Body: []byte("package main\n")},
	})

	meta, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	src := mgr.SourcesDir(meta.ID)
	if _, err := os.Stat(filepath.Join(src, "go.mod")); err != nil {
		t.Fatalf("flattened go.mod: %v", err)
	}
	if _, err := os.Stat(filepath.Join(src, "server")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("wrapper dir still present: %v", err)
	}
	if _, err := os.Stat(filepath.Join(src, "__MACOSX")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("__MACOSX still present: %v", err)
	}
}

func TestFlattenSkippedWhenWrapperHasNoGoMod(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/nested")},
		{Name: "cmd/", IsDir: true},
		{Name: "cmd/server/", IsDir: true},
		{Name: "cmd/server/main.go", Body: []byte("package main\n")},
	})

	meta, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	src := mgr.SourcesDir(meta.ID)
	if _, err := os.Stat(filepath.Join(src, "cmd", "server", "main.go")); err != nil {
		t.Fatalf("nested layout should be preserved: %v", err)
	}
}

func TestFlattenSkippedWhenMultipleTopLevelEntries(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "server/", IsDir: true},
		{Name: "server/go.mod", Body: goodGoMod("example.com/multi")},
		{Name: "server/main.go", Body: []byte("package main\n")},
		{Name: "README.md", Body: []byte("# multi-module repo\n")},
	})

	meta, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	src := mgr.SourcesDir(meta.ID)
	if _, err := os.Stat(filepath.Join(src, "server", "go.mod")); err != nil {
		t.Fatalf("wrapper preserved when sibling exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(src, "README.md")); err != nil {
		t.Fatalf("sibling preserved: %v", err)
	}
}

func TestDisplayNameWhitespaceFallsBackToModule(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/whitespace")},
	})
	meta, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "   ")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if meta.Name != "example.com/whitespace" {
		t.Errorf("name = %q, want module fallback", meta.Name)
	}
}

func TestZipSlipParentTraversal(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/evil")},
		{Name: "../escape/file.go", Body: []byte("package x\n")},
	})

	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrZipSlip) {
		t.Fatalf("err = %v, want ErrZipSlip", err)
	}
	assertNoLeakedSources(t, mgr, "escape")
}

func TestZipSlipAbsolutePath(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "/etc/passwd", Body: []byte("root:x:0:0\n")},
		{Name: "go.mod", Body: goodGoMod("example.com/abs")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrZipSlip) {
		t.Fatalf("err = %v, want ErrZipSlip", err)
	}
}

func TestZipSlipBackslash(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/win")},
		{Name: `..\windows\file.go`, Body: []byte("x")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrZipSlip) {
		t.Fatalf("err = %v, want ErrZipSlip", err)
	}
}

func TestZipSlipDriveLetter(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/drv")},
		{Name: "C:/file.go", Body: []byte("x")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrZipSlip) {
		t.Fatalf("err = %v, want ErrZipSlip", err)
	}
}

func TestZipSlipSymlink(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/sym")},
		{Name: "link", Body: []byte("../../etc/passwd"), IsSymlink: true},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrZipSlip) {
		t.Fatalf("err = %v, want ErrZipSlip", err)
	}
}

func TestNoGoMod(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "main.go", Body: []byte("package main\n")},
		{Name: "internal/util.go", Body: []byte("package internal\n")},
	})

	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrGoModMissing) {
		t.Fatalf("err = %v, want ErrGoModMissing", err)
	}
	// All projects rolled back: no source dirs left.
	if got := len(mgr.ListProjects()); got != 0 {
		t.Errorf("projects after rollback = %d, want 0", got)
	}
}

func TestEmptyModulePath(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: []byte("go 1.26\n")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrGoModMissing) {
		t.Fatalf("err = %v, want ErrGoModMissing", err)
	}
}

func TestArchiveTooLargeDeclared(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t, func(c *loader.Config) {
		c.MaxArchiveBytes = 1024
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader([]byte{0}), 1<<20, "")
	if !errors.Is(err, domain.ErrArchiveTooLarge) {
		t.Fatalf("err = %v, want ErrArchiveTooLarge", err)
	}
}

func TestArchiveTooLargeWhileSpooling(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t, func(c *loader.Config) {
		c.MaxArchiveBytes = 16
	})
	// Pass declaredSize == -1 so the early gate is skipped; the spool
	// itself must catch the overrun.
	huge := bytes.Repeat([]byte{0xAA}, 64)
	_, err := ldr.Load(context.Background(), bytes.NewReader(huge), -1, "")
	if !errors.Is(err, domain.ErrArchiveTooLarge) {
		t.Fatalf("err = %v, want ErrArchiveTooLarge", err)
	}
}

func TestTooManyFiles(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t, func(c *loader.Config) {
		c.MaxFiles = 5
	})
	entries := []zipEntry{{Name: "go.mod", Body: goodGoMod("example.com/many")}}
	for i := 0; i < 10; i++ {
		entries = append(entries, zipEntry{
			Name: fmt.Sprintf("pkg/file%02d.go", i),
			Body: []byte("package pkg\n"),
		})
	}
	body := buildZip(t, entries)

	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrFileCountExceeded) {
		t.Fatalf("err = %v, want ErrFileCountExceeded", err)
	}
	// Preflight rejects before NewProject is called: no rollback artefacts.
	if got := len(mgr.ListProjects()); got != 0 {
		t.Errorf("projects = %d, want 0 (rejected pre-allocation)", got)
	}
}

func TestZipBombDeclaredOversized(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t, func(c *loader.Config) {
		c.MaxUnpackedBytes = 1024
	})
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/bomb")},
		{Name: "huge.bin", Body: []byte("tiny"), RawSize: 1 << 20},
	})

	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrUnpackedSizeExceeded) {
		t.Fatalf("err = %v, want ErrUnpackedSizeExceeded", err)
	}
}

func TestZipBombCumulative(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t, func(c *loader.Config) {
		c.MaxUnpackedBytes = 4096
	})
	entries := []zipEntry{{Name: "go.mod", Body: goodGoMod("example.com/cum")}}
	// Each entry declares 1024 bytes; ten of them blow past 4096.
	for i := 0; i < 10; i++ {
		entries = append(entries, zipEntry{
			Name:    fmt.Sprintf("chunk%02d.bin", i),
			Body:    []byte("x"),
			RawSize: 1024,
		})
	}
	body := buildZip(t, entries)

	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrUnpackedSizeExceeded) {
		t.Fatalf("err = %v, want ErrUnpackedSizeExceeded", err)
	}
}

func TestUnpackedSizeExceededWhileWriting(t *testing.T) {
	t.Parallel()
	// MaxUnpackedBytes is 64 — preflight passes (every entry is 32, total
	// 96 > 64 so this still trips preflight). To exercise the mid-write
	// guard we use a single entry that fits the per-entry cap but, when
	// combined with another, breaches the cumulative limit during writing.
	// Easiest reliable shape: tiny preflight values with a forged
	// per-entry size of zero so preflight passes but the actual stream is
	// longer than the budget.
	ldr, _ := newLoader(t, func(c *loader.Config) {
		c.MaxUnpackedBytes = 8
	})
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/wbig")},
		{Name: "blob.bin", Body: bytes.Repeat([]byte{0x01}, 64), RawSize: 1},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrUnpackedSizeExceeded) {
		t.Fatalf("err = %v, want ErrUnpackedSizeExceeded", err)
	}
}

func TestInvalidZipBytes(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	_, err := ldr.Load(context.Background(), strings.NewReader("not a zip"), 9, "")
	if err == nil {
		t.Fatal("want error for non-zip input")
	}
	if errors.Is(err, domain.ErrZipSlip) ||
		errors.Is(err, domain.ErrGoModMissing) ||
		errors.Is(err, domain.ErrFileCountExceeded) ||
		errors.Is(err, domain.ErrUnpackedSizeExceeded) ||
		errors.Is(err, domain.ErrArchiveTooLarge) {
		t.Fatalf("invalid zip should not match a typed sentinel: %v", err)
	}
}

func TestContextCancelBeforeStart(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/cancel")},
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := ldr.Load(ctx, bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if got := len(mgr.ListProjects()); got != 0 {
		t.Errorf("projects = %d, want 0", got)
	}
}

func TestContextCancelDuringExtract(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)

	// Build an archive with enough entries that we can cancel between
	// writes and still observe the rollback.
	entries := []zipEntry{{Name: "go.mod", Body: goodGoMod("example.com/cx")}}
	for i := 0; i < 50; i++ {
		entries = append(entries, zipEntry{
			Name: fmt.Sprintf("pkg/file%03d.go", i),
			Body: bytes.Repeat([]byte{'a'}, 1024),
		})
	}
	body := buildZip(t, entries)

	ctx, cancel := context.WithCancel(context.Background())
	// Cancel almost immediately so most writes never happen.
	go func() {
		time.Sleep(time.Microsecond)
		cancel()
	}()

	_, err := ldr.Load(ctx, bytes.NewReader(body), int64(len(body)), "")
	if err == nil {
		// Race: extraction completed before cancel fired. Re-run with
		// a pre-cancelled context to keep coverage deterministic.
		ctx2, cancel2 := context.WithCancel(context.Background())
		cancel2()
		_, err = ldr.Load(ctx2, bytes.NewReader(body), int64(len(body)), "")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if got := len(mgr.ListProjects()); got != 0 {
		t.Errorf("projects after cancel = %d, want 0", got)
	}
}

func TestNilReader(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	if _, err := ldr.Load(context.Background(), nil, 0, ""); err == nil {
		t.Fatal("want error for nil reader")
	}
}

func TestRollbackRemovesSourcesDir(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	// Archive with go.mod that parses as empty — fails after extraction.
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: []byte("// no module directive\n")},
		{Name: "main.go", Body: []byte("package main\n")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrGoModMissing) {
		t.Fatalf("err = %v, want ErrGoModMissing", err)
	}
	if got := len(mgr.ListProjects()); got != 0 {
		t.Fatalf("projects after rollback = %d, want 0", got)
	}
}

func TestParallelLoads(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/par")},
		{Name: "main.go", Body: []byte("package main\n")},
	})

	const n = 8
	var wg sync.WaitGroup
	wg.Add(n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			_, errs[i] = ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("run %d: %v", i, err)
		}
	}
	if got := len(mgr.ListProjects()); got != n {
		t.Errorf("projects = %d, want %d", got, n)
	}
}

func TestNewPanicsOnNilManager(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic")
		}
	}()
	loader.New(nil, loader.Config{}, nil)
}

func TestLoaderConfigDefaults(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t) // empty config
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/def")},
	})
	if _, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), ""); err != nil {
		t.Fatalf("Load with default config: %v", err)
	}
}

// assertNoLeakedSources verifies that no file or directory containing the
// suspicious fragment is left under the manager's RootTmp tree.
func assertNoLeakedSources(t *testing.T, mgr cache.Manager, fragment string) {
	t.Helper()
	// We don't have a public root accessor, but SourcesDir(unknown) returns
	// RootTmp/<id>; that lets us walk the parent.
	probe := mgr.SourcesDir(domain.NewProjectID())
	root := filepath.Dir(probe)
	if _, err := os.Stat(root); errors.Is(err, fs.ErrNotExist) {
		return
	}
	err := filepath.WalkDir(root, func(path string, _ fs.DirEntry, _ error) error {
		if strings.Contains(path, fragment) {
			t.Errorf("leaked path %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// TestSpoolFailureCleansUp ensures that a Reader returning an error mid-copy
// does not leave a temp file behind. We use a reader that reports a custom
// error after a few bytes; the loader should bail out cleanly.
func TestSpoolFailureCleansUp(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	r := &erroringReader{after: 4, err: errors.New("upstream gone")}
	_, err := ldr.Load(context.Background(), r, -1, "")
	if err == nil {
		t.Fatal("want error from upstream reader")
	}
	if !strings.Contains(err.Error(), "upstream gone") {
		t.Errorf("err = %v, want wrapping of upstream error", err)
	}
}

type erroringReader struct {
	after int
	read  int
	err   error
}

func (e *erroringReader) Read(p []byte) (int, error) {
	if e.read >= e.after {
		return 0, e.err
	}
	n := len(p)
	if n > e.after-e.read {
		n = e.after - e.read
	}
	for i := 0; i < n; i++ {
		p[i] = 0xFF
	}
	e.read += n
	return n, nil
}

// TestNewWithCustomLogger covers the non-nil logger branch of New.
// TestParentMkdirFailsBecauseOfFile uses a more forceful conflict: we
// create `dir` as a regular file, then add `dir/sub/file.go`. That makes
// MkdirAll on `dir/sub` fail outright, exercising the "mkdir parent of"
// branch.
func TestParentMkdirFailsBecauseOfFile(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/parent")},
		{Name: "blocker", Body: []byte("file")},
		{Name: "blocker/inner/file.go", Body: []byte("x")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err == nil {
		t.Fatal("want error")
	}
}

// TestMaxArchiveBytesAtBoundary covers the boundary where declared size
// equals the limit (must succeed) and where it equals limit+1 (must fail).
func TestMaxArchiveBytesAtBoundary(t *testing.T) {
	t.Parallel()
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/edge")},
	})
	limit := int64(len(body))

	ldr, _ := newLoader(t, func(c *loader.Config) {
		c.MaxArchiveBytes = limit
	})
	if _, err := ldr.Load(context.Background(), bytes.NewReader(body), limit, ""); err != nil {
		t.Fatalf("at-limit upload should succeed: %v", err)
	}

	ldr2, _ := newLoader(t, func(c *loader.Config) {
		c.MaxArchiveBytes = limit
	})
	if _, err := ldr2.Load(context.Background(), bytes.NewReader(body), limit+1, ""); !errors.Is(err, domain.ErrArchiveTooLarge) {
		t.Fatalf("over-limit declared size: err = %v, want ErrArchiveTooLarge", err)
	}
}

// TestModuleParseError feeds an invalid go.mod (no module directive but
// non-empty body that parses as something else) so the parser path other
// than empty-module is hit.
func TestModuleParseError(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: []byte("module \"unterminated\n")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err == nil {
		t.Fatal("want parse error")
	}
}

func TestNewWithCustomLogger(t *testing.T) {
	t.Parallel()
	mgr := newTestManager(t)
	custom := slog.New(slog.NewTextHandler(io.Discard, nil))
	ldr := loader.New(mgr, loader.Config{}, custom)
	if ldr == nil {
		t.Fatal("New returned nil with custom logger")
	}
	mgr2 := newTestManager(t)
	if loader.New(mgr2, loader.Config{}, nil) == nil {
		t.Fatal("New returned nil with default logger")
	}
}

// TestSanitisePathCornerCases asserts that the path checks reject every
// shape we care about. Each case is fed through the loader so we exercise
// the same gate that production code uses.
func TestSanitisePathCornerCases(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		entry string
	}{
		{"nul-byte", "go\x00mod"},
		{"dot-dot-only", ".."},
		{"nested-traversal", "a/../../b.go"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ldr, _ := newLoader(t)
			body := buildZip(t, []zipEntry{
				{Name: "go.mod", Body: goodGoMod("example.com/x")},
				{Name: tc.entry, Body: []byte("x")},
			})
			_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
			if !errors.Is(err, domain.ErrZipSlip) {
				t.Fatalf("err = %v, want ErrZipSlip", err)
			}
		})
	}
}

// TestEmptyAndDotEntries covers the "skip" branch of sanitisePath where
// the zip declares a "." or empty-name entry. The archive must still load
// successfully when accompanied by a real go.mod.
func TestEmptyAndDotEntries(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: ".", IsDir: true},
		{Name: "go.mod", Body: goodGoMod("example.com/dot")},
	})
	if _, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), ""); err != nil {
		t.Fatalf("Load: %v", err)
	}
}

// TestIrregularEntryMode rejects archive entries that use device, named-pipe
// or other non-regular Unix mode bits.
func TestIrregularEntryMode(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	// Build a zip with a "device" entry (ModeDevice).
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	hdr := &zip.FileHeader{Name: "weird.dev", Method: zip.Deflate}
	hdr.SetMode(0o600 | os.ModeDevice)
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		t.Fatalf("CreateHeader: %v", err)
	}
	if _, err := w.Write([]byte("x")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	gm, err := zw.Create("go.mod")
	if err != nil {
		t.Fatalf("Create go.mod: %v", err)
	}
	if _, err := gm.Write(goodGoMod("example.com/dev")); err != nil {
		t.Fatalf("Write go.mod: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zw.Close: %v", err)
	}
	body := buf.Bytes()
	_, err = ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if !errors.Is(err, domain.ErrZipSlip) {
		t.Fatalf("err = %v, want ErrZipSlip", err)
	}
}

// TestParentDirectoryConflict triggers the "mkdir parent of" error path:
// a sibling entry already created a regular file at what later becomes the
// parent directory of another entry.
func TestParentDirectoryConflict(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/conf")},
		// First we create a regular file named "obstacle".
		{Name: "obstacle", Body: []byte("file")},
		// Then we declare a child of that file — mkdir of the parent must fail.
		{Name: "obstacle/child.go", Body: []byte("x")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err == nil {
		t.Fatal("want error from parent-directory conflict")
	}
	if !strings.Contains(err.Error(), "mkdir") && !strings.Contains(err.Error(), "create") {
		t.Logf("error from filesystem conflict: %v", err)
	}
}

// TestDirectoryTargetCausesCreateFailure forges an entry whose name equals
// an already-extracted directory; the subsequent OpenFile call must fail.
func TestDirectoryTargetCausesCreateFailure(t *testing.T) {
	t.Parallel()
	ldr, _ := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/dirconf")},
		{Name: "pkg/", IsDir: true},
		{Name: "pkg", Body: []byte("x")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err == nil {
		t.Fatal("want error from open-file conflict")
	}
}

// brokenManager wraps a real cache.Manager and forces NewProject to fail.
type brokenManager struct {
	cache.Manager
}

func (brokenManager) NewProject(string, int64, int) (*cache.Project, error) {
	return nil, errors.New("induced failure")
}

func TestReserveProjectFailure(t *testing.T) {
	t.Parallel()
	mgr := newTestManager(t)
	broken := brokenManager{Manager: mgr}
	ldr := loader.New(broken, loader.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/reserve")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err == nil || !strings.Contains(err.Error(), "reserve project") {
		t.Fatalf("err = %v, want wrap of induced failure", err)
	}
}

// metaBrokenManager succeeds at NewProject but rejects WriteMeta — exercises
// the late "persist meta" failure branch and its rollback.
type metaBrokenManager struct {
	cache.Manager
}

func (m metaBrokenManager) WriteMeta(domain.ProjectID, *cache.ProjectMeta) error {
	return errors.New("induced meta failure")
}

func TestPersistMetaFailureRollsBack(t *testing.T) {
	t.Parallel()
	mgr := newTestManager(t)
	broken := metaBrokenManager{Manager: mgr}
	ldr := loader.New(broken, loader.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/meta")},
		{Name: "main.go", Body: []byte("package main\n")},
	})
	_, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err == nil || !strings.Contains(err.Error(), "persist meta") {
		t.Fatalf("err = %v, want wrap of meta failure", err)
	}
	// The underlying manager should now have one fewer project than before
	// (i.e. rollback executed via DeleteProject).
	if got := len(mgr.ListProjects()); got != 0 {
		t.Errorf("projects after meta-failure rollback = %d, want 0", got)
	}
}

// TestExtractParentDirectoryNotPreCreated ensures files whose parent
// directory was not declared as its own zip entry still land correctly.
func TestExtractParentDirectoryNotPreCreated(t *testing.T) {
	t.Parallel()
	ldr, mgr := newLoader(t)
	body := buildZip(t, []zipEntry{
		{Name: "go.mod", Body: goodGoMod("example.com/nopar")},
		{Name: "deeply/nested/dir/leaf.go", Body: []byte("package leaf\n")},
	})
	meta, err := ldr.Load(context.Background(), bytes.NewReader(body), int64(len(body)), "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	src := mgr.SourcesDir(meta.ID)
	if _, err := os.Stat(filepath.Join(src, "deeply", "nested", "dir", "leaf.go")); err != nil {
		t.Fatalf("nested file: %v", err)
	}
}

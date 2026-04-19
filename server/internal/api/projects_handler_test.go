package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/loader"
)

// newTinyBudgetLoader returns a Loader whose MaxFiles cap is small enough
// that a fixture with a couple of dozen entries will trip the preflight check.
func newTinyBudgetLoader(t *testing.T, mgr cache.Manager) *loader.Loader {
	t.Helper()
	return loader.New(mgr, loader.Config{MaxFiles: 4},
		slog.New(slog.DiscardHandler))
}

// newTinyUnpackedLoader returns a Loader whose unpacked-bytes budget is below
// 1 KiB so any non-trivial archive payload trips the cumulative check.
func newTinyUnpackedLoader(t *testing.T, mgr cache.Manager) *loader.Loader {
	t.Helper()
	return loader.New(mgr, loader.Config{MaxUnpackedBytes: 512},
		slog.New(slog.DiscardHandler))
}

// goMod returns the canonical go.mod body used in fixtures.
func goMod(module string) []byte {
	return []byte("module " + module + "\n\ngo 1.26\n")
}

// zipEntry mirrors the loader-test helper, kept private to this file so the
// HTTP suite stays self-contained.
type zipEntry struct {
	name string
	body []byte
	dir  bool
}

func buildZipBytes(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		name := e.name
		if e.dir && !strings.HasSuffix(name, "/") {
			name += "/"
		}
		hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
		if e.dir {
			hdr.SetMode(0o755)
		} else {
			hdr.SetMode(0o644)
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatalf("CreateHeader %q: %v", e.name, err)
		}
		if !e.dir && len(e.body) > 0 {
			if _, err := w.Write(e.body); err != nil {
				t.Fatalf("Write %q: %v", e.name, err)
			}
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zw.Close: %v", err)
	}
	return buf.Bytes()
}

// buildMultipart returns (body, contentType) for a request that carries a
// single archive part plus an optional name field.
func buildMultipart(t *testing.T, archive []byte, name string) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile(archiveFormField, "project.zip")
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := part.Write(archive); err != nil {
		t.Fatalf("write archive part: %v", err)
	}
	if name != "" {
		if err := mw.WriteField(nameFormField, name); err != nil {
			t.Fatalf("write name field: %v", err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("mw.Close: %v", err)
	}
	return buf.Bytes(), mw.FormDataContentType()
}

// postUpload issues a single POST /api/projects request with the supplied
// multipart body and returns the parsed status / body envelope.
func postUpload(t *testing.T, ts *httptest.Server, body []byte, contentType string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/projects", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", contentType)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return resp.StatusCode, raw
}

func decodeMeta(t *testing.T, body []byte) projectMetaResponse {
	t.Helper()
	var out projectMetaResponse
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode meta: %v\nbody: %s", err, body)
	}
	return out
}

func decodeError(t *testing.T, body []byte) *domain.APIError {
	t.Helper()
	var env errorEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode error: %v\nbody: %s", err, body)
	}
	if env.Error == nil {
		t.Fatalf("error envelope missing 'error' field: %s", body)
	}
	return env.Error
}

func TestPostProjects_HappyPath(t *testing.T) {
	t.Parallel()

	srv, mgr := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	archive := buildZipBytes(t, []zipEntry{
		{name: "go.mod", body: goMod("example.com/happy")},
		{name: "main.go", body: []byte("package main\nfunc main(){}\n")},
		{name: "internal/", dir: true},
		{name: "internal/util.go", body: []byte("package internal\n")},
	})
	body, ct := buildMultipart(t, archive, "")

	status, raw := postUpload(t, ts, body, ct)
	if status != http.StatusCreated {
		t.Fatalf("status: got %d, want 201; body=%s", status, raw)
	}
	meta := decodeMeta(t, raw)

	if !meta.ProjectID.IsValid() {
		t.Errorf("project_id %q is not a valid id", meta.ProjectID)
	}
	if meta.Name != "example.com/happy" {
		t.Errorf("name = %q, want module fallback", meta.Name)
	}
	if meta.FileCount != 3 {
		t.Errorf("file_count = %d, want 3", meta.FileCount)
	}
	if meta.SizeBytes <= 0 {
		t.Errorf("size_bytes = %d, want > 0", meta.SizeBytes)
	}
	if meta.UploadedAt.IsZero() || meta.ExpiresAt.IsZero() {
		t.Errorf("uploaded_at/expires_at must be set: %+v", meta)
	}
	// The test cache.Manager runs with IdleTTL=1h (see newTestServer); the
	// production default is 30m per NFR-10 and is verified separately by the
	// cache package tests.
	gotTTL := meta.ExpiresAt.Sub(meta.UploadedAt)
	if gotTTL < 55*time.Minute || gotTTL > 65*time.Minute {
		t.Errorf("expires_at - uploaded_at = %s, want ~1h (test config)", gotTTL)
	}

	// The cache must surface the same record post-upload.
	stored, err := mgr.GetProject(meta.ProjectID)
	if err != nil {
		t.Fatalf("cache.GetProject after upload: %v", err)
	}
	if stored.Meta.Name != meta.Name {
		t.Errorf("cache name = %q, want %q", stored.Meta.Name, meta.Name)
	}
}

func TestPostProjects_DisplayNameOverride(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	archive := buildZipBytes(t, []zipEntry{
		{name: "go.mod", body: goMod("example.com/named")},
	})
	body, ct := buildMultipart(t, archive, "Custom Project")

	status, raw := postUpload(t, ts, body, ct)
	if status != http.StatusCreated {
		t.Fatalf("status: got %d, want 201; body=%s", status, raw)
	}
	meta := decodeMeta(t, raw)
	if meta.Name != "Custom Project" {
		t.Errorf("name = %q, want display override", meta.Name)
	}
}

func TestPostProjects_NoArchiveField(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("name", "foo"); err != nil {
		t.Fatalf("write field: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("mw.Close: %v", err)
	}

	status, raw := postUpload(t, ts, buf.Bytes(), mw.FormDataContentType())
	if status != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400; body=%s", status, raw)
	}
	apiErr := decodeError(t, raw)
	if apiErr.Code != codeInvalidZip {
		t.Errorf("code = %q, want %q", apiErr.Code, codeInvalidZip)
	}
}

func TestPostProjects_TooLarge(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// We forge the multipart preamble by hand and stream null bytes for the
	// archive part instead of allocating 60 MiB up-front. The handler must
	// reject the body as soon as MaxBytesReader trips, before reading the
	// full payload.
	boundary := "----TooLargeBoundary"
	preamble := "--" + boundary + "\r\n" +
		`Content-Disposition: form-data; name="archive"; filename="big.zip"` + "\r\n" +
		"Content-Type: application/zip\r\n\r\n"
	trailer := "\r\n--" + boundary + "--\r\n"
	overshoot := MaxUploadBytes + 1024

	body := io.MultiReader(
		strings.NewReader(preamble),
		io.LimitReader(zeroReader{}, overshoot),
		strings.NewReader(trailer),
	)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/projects", body)
	req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)

	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status: got %d, want 413; body=%s", resp.StatusCode, raw)
	}
	apiErr := decodeError(t, raw)
	if apiErr.Code != codeArchiveTooLarge {
		t.Errorf("code = %q, want %q", apiErr.Code, codeArchiveTooLarge)
	}
}

// zeroReader returns null bytes forever — used to feed MaxBytesReader without
// holding the full payload in memory.
type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}

func TestPostProjects_ZipSlip(t *testing.T) {
	t.Parallel()

	srv, mgr := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	archive := buildZipBytes(t, []zipEntry{
		{name: "go.mod", body: goMod("example.com/slip")},
		{name: "../escape/file.go", body: []byte("package x\n")},
	})
	body, ct := buildMultipart(t, archive, "")

	status, raw := postUpload(t, ts, body, ct)
	if status != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400; body=%s", status, raw)
	}
	apiErr := decodeError(t, raw)
	if apiErr.Code != codeZipSlipDetected {
		t.Errorf("code = %q, want %q", apiErr.Code, codeZipSlipDetected)
	}
	// No project should have been registered.
	if got := len(mgr.ListProjects()); got != 0 {
		t.Errorf("projects after slip = %d, want 0", got)
	}
}

func TestPostProjects_NoGoMod(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	archive := buildZipBytes(t, []zipEntry{
		{name: "main.go", body: []byte("package main\n")},
	})
	body, ct := buildMultipart(t, archive, "")

	status, raw := postUpload(t, ts, body, ct)
	if status != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400; body=%s", status, raw)
	}
	apiErr := decodeError(t, raw)
	if apiErr.Code != codeGoModMissing {
		t.Errorf("code = %q, want %q", apiErr.Code, codeGoModMissing)
	}
	if !strings.Contains(apiErr.Message, "valid Go module") {
		t.Errorf("message = %q, want FR-01 wording", apiErr.Message)
	}
}

func TestPostProjects_FileCountExceeded(t *testing.T) {
	t.Parallel()

	// Build a server with a *tight* file-count budget so we don't have to
	// stream 10 001 entries through the test process.
	mgr, err := cache.New(cache.Options{
		RootTmp:       t.TempDir(),
		RootCache:     t.TempDir(),
		IdleTTL:       time.Hour,
		SweepInterval: time.Hour,
		Logger:        slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	srv, err := NewServer(Config{
		Cache:    mgr,
		StaticFS: testFS(),
		Logger:   slog.New(slog.DiscardHandler),
		Loader:   newTinyBudgetLoader(t, mgr),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	entries := []zipEntry{{name: "go.mod", body: goMod("example.com/many")}}
	for i := 0; i < 32; i++ {
		entries = append(entries, zipEntry{
			name: fmt.Sprintf("pkg/file%02d.go", i),
			body: []byte("package pkg\n"),
		})
	}
	archive := buildZipBytes(t, entries)
	body, ct := buildMultipart(t, archive, "")

	status, raw := postUpload(t, ts, body, ct)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("status: got %d, want 422; body=%s", status, raw)
	}
	apiErr := decodeError(t, raw)
	if apiErr.Code != codeFileCountExceeded {
		t.Errorf("code = %q, want %q", apiErr.Code, codeFileCountExceeded)
	}
}

func TestPostProjects_UnpackedSizeExceeded(t *testing.T) {
	t.Parallel()

	mgr, err := cache.New(cache.Options{
		RootTmp:       t.TempDir(),
		RootCache:     t.TempDir(),
		IdleTTL:       time.Hour,
		SweepInterval: time.Hour,
		Logger:        slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	srv, err := NewServer(Config{
		Cache:    mgr,
		StaticFS: testFS(),
		Logger:   slog.New(slog.DiscardHandler),
		Loader:   newTinyUnpackedLoader(t, mgr),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	archive := buildZipBytes(t, []zipEntry{
		{name: "go.mod", body: goMod("example.com/big")},
		{name: "data.txt", body: bytes.Repeat([]byte("x"), 4096)},
	})
	body, ct := buildMultipart(t, archive, "")

	status, raw := postUpload(t, ts, body, ct)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("status: got %d, want 422; body=%s", status, raw)
	}
	apiErr := decodeError(t, raw)
	if apiErr.Code != codeUnpackedSizeExceeded {
		t.Errorf("code = %q, want %q", apiErr.Code, codeUnpackedSizeExceeded)
	}
}

func TestPostProjects_Idempotency_DistinctIDs(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	archive := buildZipBytes(t, []zipEntry{
		{name: "go.mod", body: goMod("example.com/twice")},
		{name: "main.go", body: []byte("package main\n")},
	})
	body, ct := buildMultipart(t, archive, "")

	status1, raw1 := postUpload(t, ts, body, ct)
	if status1 != http.StatusCreated {
		t.Fatalf("first POST: %d / %s", status1, raw1)
	}
	first := decodeMeta(t, raw1)

	body2, ct2 := buildMultipart(t, archive, "")
	status2, raw2 := postUpload(t, ts, body2, ct2)
	if status2 != http.StatusCreated {
		t.Fatalf("second POST: %d / %s", status2, raw2)
	}
	second := decodeMeta(t, raw2)

	if first.ProjectID == second.ProjectID {
		t.Errorf("two uploads should produce distinct project_ids; got %s twice",
			first.ProjectID)
	}
}

func TestPostProjects_TTLMatchesContract(t *testing.T) {
	t.Parallel()

	// Cache.New picks DefaultIdleTTL (30m, NFR-10) when IdleTTL is zero. We
	// build a fresh Manager here so the assertion stays close to the
	// production wiring without coupling to newTestServer's overrides.
	mgr, err := cache.New(cache.Options{
		RootTmp:   t.TempDir(),
		RootCache: t.TempDir(),
		Logger:    slog.New(slog.DiscardHandler),
		// SweepInterval intentionally large so the goroutine never fires
		// during the test.
		SweepInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("cache.New: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	srv, err := NewServer(Config{
		Cache:    mgr,
		StaticFS: testFS(),
		Logger:   slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	archive := buildZipBytes(t, []zipEntry{
		{name: "go.mod", body: goMod("example.com/ttl")},
	})
	body, ct := buildMultipart(t, archive, "")

	status, raw := postUpload(t, ts, body, ct)
	if status != http.StatusCreated {
		t.Fatalf("status: got %d, want 201; body=%s", status, raw)
	}
	meta := decodeMeta(t, raw)
	want := 30 * time.Minute
	delta := meta.ExpiresAt.Sub(meta.UploadedAt)
	if delta < want-time.Minute || delta > want+time.Minute {
		t.Errorf("expires_at - uploaded_at = %s, want ~%s (NFR-10)", delta, want)
	}
}

func TestPostProjects_BrokenZipReturnsInvalidZip(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	garbage := []byte("not a zip at all, just plain bytes")
	body, ct := buildMultipart(t, garbage, "")

	status, raw := postUpload(t, ts, body, ct)
	if status != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400; body=%s", status, raw)
	}
	apiErr := decodeError(t, raw)
	if apiErr.Code != codeInvalidZip {
		t.Errorf("code = %q, want %q", apiErr.Code, codeInvalidZip)
	}
}

func TestPostProjects_EmptyArchivePart(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	body, ct := buildMultipart(t, nil, "")
	status, raw := postUpload(t, ts, body, ct)
	if status != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400; body=%s", status, raw)
	}
	apiErr := decodeError(t, raw)
	if apiErr.Code != codeInvalidZip {
		t.Errorf("code = %q, want %q", apiErr.Code, codeInvalidZip)
	}
}

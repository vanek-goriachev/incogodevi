package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// deadCodeFixture mirrors the report shape used in api-contract.md §4.
func deadCodeFixture(id domain.ProjectID) *domain.DeadCodeReport {
	return &domain.DeadCodeReport{
		ProjectID:   id,
		GeneratedAt: time.Date(2026, 4, 18, 12, 35, 4, 0, time.UTC),
		Entries: []domain.DeadCodeEntry{
			{
				Kind:    domain.NodeKindMethod,
				FQN:     "github.com/acme/example/store.MongoStore.Close",
				Package: "github.com/acme/example/store",
				Name:    "Close",
				File:    "store/mongo.go",
				Line:    128,
				Reason:  "unreachable",
			},
		},
		EntriesCount: 1,
	}
}

func seedDeadCode(t *testing.T, projectName string, report *domain.DeadCodeReport) (*httptest.Server, domain.ProjectID, cache.Manager) {
	t.Helper()
	srv, mgr := newTestServer(t)
	project, err := mgr.NewProject(projectName, 1, 1)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if report != nil {
		report.ProjectID = project.Meta.ID
		if err := mgr.WriteDeadCode(project.Meta.ID, report); err != nil {
			t.Fatalf("WriteDeadCode: %v", err)
		}
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, project.Meta.ID, mgr
}

func TestDeadCode_DefaultJSON(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", deadCodeFixture(""))
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != jsonContentType {
		t.Errorf("Content-Type: got %q, want %q", got, jsonContentType)
	}
	var payload domain.DeadCodeReport
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.EntriesCount != 1 || len(payload.Entries) != 1 {
		t.Errorf("entries: %+v", payload)
	}
	if payload.Entries[0].Kind != domain.NodeKindMethod {
		t.Errorf("entry kind: %q", payload.Entries[0].Kind)
	}
}

func TestDeadCode_ExplicitFormatJSON(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", deadCodeFixture(""))
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code?format=json")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if got := resp.Header.Get("Content-Type"); got != jsonContentType {
		t.Errorf("Content-Type: got %q", got)
	}
}

func TestDeadCode_FormatTXT(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", deadCodeFixture(""))
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code?format=txt")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != contentTypeTXT {
		t.Errorf("Content-Type: got %q, want %q", got, contentTypeTXT)
	}
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		t.Errorf("Content-Disposition: got %q, want empty (no download)", cd)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "method github.com/acme/example/store.MongoStore.Close") {
		t.Errorf("body: %s", body)
	}
	if !strings.HasSuffix(string(body), "\n") {
		t.Errorf("body must end with LF: %q", body)
	}
}

func TestDeadCode_Download_AddsContentDisposition(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "my-project", deadCodeFixture(""))
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code?format=txt&download=1")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	cd := resp.Header.Get("Content-Disposition")
	if !strings.HasPrefix(cd, "attachment; filename=") {
		t.Fatalf("Content-Disposition: got %q", cd)
	}
	if !strings.Contains(cd, "dead-code.txt") {
		t.Errorf("filename should end with dead-code.txt; got %q", cd)
	}
	if !strings.Contains(cd, "my-project") {
		t.Errorf("filename should include project name; got %q", cd)
	}
}

func TestDeadCode_Download_JSONExtension(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", deadCodeFixture(""))
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code?format=json&download=1")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	cd := resp.Header.Get("Content-Disposition")
	if !strings.Contains(cd, "dead-code.json") {
		t.Errorf("Content-Disposition should mention .json: %q", cd)
	}
}

func TestDeadCode_Download_SanitisesProjectName(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, `weird/name "with quotes"`, deadCodeFixture(""))
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code?download=1")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	cd := resp.Header.Get("Content-Disposition")
	if strings.Contains(cd, `"`) && strings.Count(cd, `"`) != 2 {
		t.Errorf("filename quotes leaked into payload: %q", cd)
	}
	if strings.Contains(cd, "/") {
		t.Errorf("filename must not contain slash: %q", cd)
	}
}

func TestDeadCode_FormatTXTViaAccept(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", deadCodeFixture(""))
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/projects/"+string(id)+"/dead-code", nil)
	req.Header.Set("Accept", "text/plain")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if got := resp.Header.Get("Content-Type"); got != contentTypeTXT {
		t.Errorf("Content-Type: got %q, want %q", got, contentTypeTXT)
	}
}

func TestDeadCode_AcceptJSONOverridesTextOffer(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", deadCodeFixture(""))
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/projects/"+string(id)+"/dead-code", nil)
	req.Header.Set("Accept", "application/json, text/plain;q=0.5")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if got := resp.Header.Get("Content-Type"); got != jsonContentType {
		t.Errorf("Content-Type: got %q, want %q", got, jsonContentType)
	}
}

func TestDeadCode_InvalidFormat(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", deadCodeFixture(""))
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code?format=xml")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"invalid_format"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestDeadCode_EmptyReport_TXTSentinel(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", &domain.DeadCodeReport{
		GeneratedAt:  time.Now().UTC(),
		Entries:      []domain.DeadCodeEntry{},
		EntriesCount: 0,
	})
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code?format=txt")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	body, _ := io.ReadAll(resp.Body)
	if string(body) != "no dead code detected\n" {
		t.Errorf("body: %q, want sentinel", body)
	}
}

func TestDeadCode_EmptyReport_JSONEmptyArray(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", &domain.DeadCodeReport{
		GeneratedAt:  time.Now().UTC(),
		Entries:      []domain.DeadCodeEntry{},
		EntriesCount: 0,
	})
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code?format=json")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"entries":[]`) {
		t.Errorf("body must include empty array: %s", body)
	}
}

func TestDeadCode_NoGraphYet(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedDeadCode(t, "demo", nil)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/dead-code")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: got %d, want 404", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"no_graph_yet"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestDeadCode_StaleCache(t *testing.T) {
	t.Parallel()

	srv, mgr := newTestServer(t)
	project, _ := mgr.NewProject("corrupt", 1, 1)
	if err := os.WriteFile(filepath.Join(project.CacheDir, "dead-code.json"), []byte("not-json"), 0o600); err != nil {
		t.Fatalf("seed corrupt: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/projects/" + string(project.Meta.ID) + "/dead-code")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d, want 503", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"stale_cache"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestTranslateDeadCodeReadError_ProjectNotFound(t *testing.T) {
	t.Parallel()

	out := translateDeadCodeReadError(domain.ErrProjectNotFound, "abc")
	apiErr, ok := asAPIError(out)
	if !ok || apiErr.Code != codeProjectNotFound {
		t.Fatalf("got %v, want project_not_found", out)
	}
}

func TestTranslateDeadCodeReadError_UnknownPropagates(t *testing.T) {
	t.Parallel()

	bogus := io.EOF
	out := translateDeadCodeReadError(bogus, "abc")
	if out != bogus {
		t.Errorf("unknown error should be returned untouched: got %v", out)
	}
}

func TestSanitizeFilenameEdgeCases(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in, want string
	}{
		{"", "project"},
		{".....", "project"},
		{"hello", "hello"},
		{"a b c", "a_b_c"},
		{"weird/name", "weird_name"},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			t.Parallel()
			got := attachmentHeader(c.in, "txt")
			want := `attachment; filename="` + c.want + `-dead-code.txt"`
			if got != want {
				t.Errorf("got %q, want %q", got, want)
			}
		})
	}
}

func TestAcceptPrefersText(t *testing.T) {
	t.Parallel()

	cases := []struct {
		accept string
		want   bool
	}{
		{"", false},
		{"*/*", false},
		{"text/plain", true},
		{"text/plain, application/json", false},
		{"application/json", false},
		{"text/html", false},
	}
	for _, c := range cases {
		t.Run(c.accept, func(t *testing.T) {
			t.Parallel()
			if got := acceptPrefersText(c.accept); got != c.want {
				t.Errorf("acceptPrefersText(%q) = %v, want %v", c.accept, got, c.want)
			}
		})
	}
}

func TestDeadCode_GarbageProjectIDIs404(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/projects/garbage/dead-code")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: %d, want 404", resp.StatusCode)
	}
}

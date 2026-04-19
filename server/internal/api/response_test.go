package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

func TestWriteJSON_SetsContentType(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusCreated, map[string]string{"hello": "world"})

	if rec.Code != http.StatusCreated {
		t.Errorf("code: got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != jsonContentType {
		t.Errorf("Content-Type: got %q", got)
	}
	var decoded map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded["hello"] != "world" {
		t.Errorf("payload: %v", decoded)
	}
}

func TestWriteAPIError_NilNoOp(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeAPIError(rec, httptest.NewRequest(http.MethodGet, "/", nil), nil)
	if rec.Code != http.StatusOK { // recorder default
		t.Errorf("nil error should not write a status")
	}
	if rec.Body.Len() != 0 {
		t.Errorf("nil error should not write a body, got %q", rec.Body.String())
	}
}

func TestWriteAPIError_WrappedAPIError(t *testing.T) {
	t.Parallel()

	wrapped := fmt.Errorf("looking up: %w", errProjectNotFound("abc"))
	rec := httptest.NewRecorder()
	writeAPIError(rec, httptest.NewRequest(http.MethodGet, "/", nil), wrapped)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("code: got %d, want 404", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"code":"project_not_found"`) {
		t.Errorf("envelope: %s", body)
	}
	if !strings.Contains(body, `"project_id":"abc"`) {
		t.Errorf("details: %s", body)
	}
}

func TestWriteAPIError_PlainErrorBecomesInternal(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeAPIError(rec, httptest.NewRequest(http.MethodGet, "/", nil), errors.New("oops"))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("code: got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"code":"internal"`) {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestWriteAPIError_DefaultStatusFallback(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	apiErr := &domain.APIError{Code: "unset_status", Message: "no status"}
	writeAPIError(rec, httptest.NewRequest(http.MethodGet, "/", nil), apiErr)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("code: got %d, want 500", rec.Code)
	}
}

func TestAsProjectIDOr404_Valid(t *testing.T) {
	t.Parallel()

	id := domain.NewProjectID()
	got, err := asProjectIDOr404(string(id))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != id {
		t.Errorf("id: got %s, want %s", got, id)
	}
}

func TestAsProjectIDOr404_Invalid(t *testing.T) {
	t.Parallel()

	_, err := asProjectIDOr404("nope")
	apiErr, ok := asAPIError(err)
	if !ok {
		t.Fatalf("expected APIError, got %v", err)
	}
	if apiErr.Code != codeProjectNotFound {
		t.Errorf("code: %s", apiErr.Code)
	}
	if apiErr.HTTPStatus != http.StatusNotFound {
		t.Errorf("status: %d", apiErr.HTTPStatus)
	}
}

func TestIsProjectNotFound(t *testing.T) {
	t.Parallel()
	if !isProjectNotFound(domain.ErrProjectNotFound) {
		t.Errorf("expected true for sentinel")
	}
	if isProjectNotFound(errors.New("other")) {
		t.Errorf("expected false for unrelated error")
	}
}

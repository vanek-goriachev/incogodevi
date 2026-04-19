package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestSentinelErrors_Distinct(t *testing.T) {
	t.Parallel()

	all := []error{
		ErrProjectNotFound,
		ErrNoGraphYet,
		ErrInvalidEntryPoint,
		ErrZipSlip,
		ErrGoModMissing,
		ErrArchiveTooLarge,
		ErrFileCountExceeded,
		ErrUnpackedSizeExceeded,
		ErrAnalysisInProgress,
	}
	seen := make(map[string]struct{}, len(all))
	for _, e := range all {
		if e == nil {
			t.Fatalf("nil sentinel error")
		}
		if _, dup := seen[e.Error()]; dup {
			t.Fatalf("duplicate sentinel message %q", e.Error())
		}
		seen[e.Error()] = struct{}{}
	}
}

func TestSentinelErrors_WrappableWithErrorsIs(t *testing.T) {
	t.Parallel()

	wrapped := fmt.Errorf("looking up xyz: %w", ErrProjectNotFound)
	if !errors.Is(wrapped, ErrProjectNotFound) {
		t.Fatalf("expected errors.Is to walk the wrapped chain")
	}
}

func TestAPIError_Error(t *testing.T) {
	t.Parallel()

	err := &APIError{Code: "project_not_found", Message: "id missing"}
	got := err.Error()
	if !strings.Contains(got, "project_not_found") || !strings.Contains(got, "id missing") {
		t.Fatalf("Error(): %q", got)
	}

	noCode := &APIError{Message: "boom"}
	if noCode.Error() != "boom" {
		t.Fatalf("expected bare message, got %q", noCode.Error())
	}

	var nilErr *APIError
	if got := nilErr.Error(); got == "" {
		t.Fatalf("nil APIError should return non-empty placeholder")
	}
}

func TestAPIError_JSON_HidesHTTPStatus(t *testing.T) {
	t.Parallel()

	err := &APIError{
		Code:       "project_not_found",
		Message:    "project x not found",
		Details:    map[string]any{"project_id": "x"},
		HTTPStatus: http.StatusNotFound,
	}
	data, e := json.Marshal(err)
	if e != nil {
		t.Fatalf("Marshal: %v", e)
	}
	body := string(data)
	if strings.Contains(body, "http_status") || strings.Contains(body, "HTTPStatus") {
		t.Fatalf("APIError leaked http_status: %s", body)
	}
	if !strings.Contains(body, `"code":"project_not_found"`) {
		t.Fatalf("missing code in body: %s", body)
	}
	if !strings.Contains(body, `"details":{"project_id":"x"}`) {
		t.Fatalf("missing details: %s", body)
	}
}

func TestAPIError_JSON_OmitsEmptyDetails(t *testing.T) {
	t.Parallel()

	err := &APIError{Code: "no_graph_yet", Message: "run /analyze first"}
	data, e := json.Marshal(err)
	if e != nil {
		t.Fatalf("Marshal: %v", e)
	}
	if strings.Contains(string(data), `"details"`) {
		t.Fatalf("expected omitempty on Details: %s", data)
	}
}

package domain

// Warning is a non-fatal diagnostic surfaced by the analyser (NFR-08).
//
// Code uses snake_case and is stable for client-side i18n / filtering. Package
// and File are optional; either or both may be empty when the warning is not
// tied to a specific location.
type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Package string `json:"package,omitempty"`
	File    string `json:"file,omitempty"`
}

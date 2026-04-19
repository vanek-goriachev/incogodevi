package main

import (
	"testing"
)

func TestNewLoggerLevels(t *testing.T) {
	t.Parallel()

	cases := []string{"debug", "INFO", "Warn", "warning", "error", "", "bogus"}
	for _, in := range cases {
		t.Run(in, func(t *testing.T) {
			t.Parallel()
			if got := newLogger(in); got == nil {
				t.Fatalf("newLogger(%q) returned nil", in)
			}
		})
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	t.Setenv("GOVIZ_ADDR", "")
	t.Setenv("GOVIZ_LOG_LEVEL", "")

	cfg := loadConfig()
	if cfg.addr != defaultAddr {
		t.Errorf("addr: got %q, want %q", cfg.addr, defaultAddr)
	}
	if cfg.logLevel != defaultLogLevel {
		t.Errorf("logLevel: got %q, want %q", cfg.logLevel, defaultLogLevel)
	}
}

func TestLoadConfigOverrides(t *testing.T) {
	t.Setenv("GOVIZ_ADDR", ":9090")
	t.Setenv("GOVIZ_LOG_LEVEL", "debug")

	cfg := loadConfig()
	if cfg.addr != ":9090" {
		t.Errorf("addr override: got %q", cfg.addr)
	}
	if cfg.logLevel != "debug" {
		t.Errorf("logLevel override: got %q", cfg.logLevel)
	}
}

func TestParseList(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", nil},
		{"single", "https://app.example", []string{"https://app.example"}},
		{"multiple_with_spaces", " https://a , https://b ,, https://c ", []string{"https://a", "https://b", "https://c"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			got := parseList(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("parseList(%q) length: got %d, want %d", c.in, len(got), len(c.want))
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Errorf("parseList(%q)[%d]: got %q, want %q", c.in, i, got[i], c.want[i])
				}
			}
		})
	}
}

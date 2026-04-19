// Package lib carries a non-main package so the auto resolver has to
// distinguish "package main" from regular project packages.
package lib

// Helper is exported but never an entry point.
func Helper() string { return "h" }

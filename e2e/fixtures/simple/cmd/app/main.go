// Package main is the entry point for the simple test fixture binary.
package main

import (
	"fmt"

	"example.com/simple/internal/util"
)

func main() {
	greeting := util.Greet("world")
	fmt.Println(greeting)
}

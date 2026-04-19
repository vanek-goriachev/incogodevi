package main

import (
	"fmt"

	_ "example.com/broken/missing"
)

func main() {
	fmt.Println("unreachable")
}

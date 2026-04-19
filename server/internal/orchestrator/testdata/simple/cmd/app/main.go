package main

import (
	"fmt"

	"example.com/simple/internal/util"
)

// Version is the build version reported on startup.
const Version = "0.1.0"

func main() {
	fmt.Println(util.Greet("world"), Version)
}

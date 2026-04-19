// Package nobody pairs a body-less FuncDecl with a regular function so the
// builder must walk both branches in the same file. The body-less form is
// what assembly-implemented stdlib helpers look like after parsing; before
// the nil-body guard was added the call walker panicked on this shape.
package nobody

// extern is implemented in another translation unit (e.g. assembly). Its
// AST FuncDecl has Body == nil, which the call walker has to handle.
func extern() int

// Caller is a normal function whose body the walker still has to inspect.
func Caller() int { return extern() + 1 }

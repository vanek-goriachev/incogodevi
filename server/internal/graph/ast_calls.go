package graph

import (
	"go/ast"
	"go/types"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
)

// addCallsAndReferences extracts intra-package call edges and weak references
// for pkg. It is invoked once per package during the second build pass, after
// every node has been registered, so cross-package targets can be looked up
// in the global object index.
//
// "calls" edges are emitted strictly between functions/methods (the
// out-of-band note on T08). Reads of vars, consts and references to type
// names produce "references" edges instead.
func (s *buildState) addCallsAndReferences(pkg parser.LivePackage) {
	if pkg.TypesInfo == nil || len(pkg.Syntax) == 0 {
		return
	}
	for _, file := range pkg.Syntax {
		s.walkFile(pkg, file)
	}
}

// walkFile walks one AST file, tracking the enclosing function on a stack so
// that every observed identifier knows which node should be the source of an
// emitted edge.
func (s *buildState) walkFile(pkg parser.LivePackage, file *ast.File) {
	stack := newFuncStack()

	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.FuncDecl:
			if id := s.funcNodeID(pkg, node); id != "" {
				stack.push(id)
				ast.Inspect(node.Body, func(child ast.Node) bool {
					return s.visitExpr(pkg, stack, child)
				})
				stack.pop()
			}
			return false
		case *ast.FuncLit:
			// Anonymous functions inherit their enclosing function's
			// identity: the use-def graph treats their body as part of
			// the outer scope for reachability purposes.
			ast.Inspect(node.Body, func(child ast.Node) bool {
				return s.visitExpr(pkg, stack, child)
			})
			return false
		}
		return true
	})
}

// visitExpr handles a single AST node during the inner walk. It returns
// false to short-circuit the descent for branches that have already been
// fully handled (avoiding double-counting), true otherwise.
func (s *buildState) visitExpr(pkg parser.LivePackage, stack *funcStack, n ast.Node) bool {
	srcID := stack.top()
	if srcID == "" {
		return true
	}

	ident, ok := identOf(n)
	if !ok {
		return true
	}
	use := pkg.TypesInfo.Uses[ident]
	if use == nil {
		return true
	}
	switch obj := use.(type) {
	case *types.Func:
		if id, ok := s.funcByObj[obj]; ok && id != srcID {
			s.addEdge(srcID, id, domain.EdgeKindCalls)
		}
	case *types.Var:
		if id, ok := s.varByObj[obj]; ok && id != srcID {
			s.addEdge(srcID, id, domain.EdgeKindReferences)
		}
	case *types.Const:
		if id, ok := s.constByObj[obj]; ok && id != srcID {
			s.addEdge(srcID, id, domain.EdgeKindReferences)
		}
	case *types.TypeName:
		if id, ok := s.typeByObj[obj]; ok && id != srcID {
			s.addEdge(srcID, id, domain.EdgeKindReferences)
		}
	}
	return true
}

// identOf returns the identifier the use lookup should be performed on.
// Selector expressions resolve via the right-hand identifier (e.g. for
// `pkg.Func()` we resolve "Func"); plain identifiers resolve directly.
func identOf(n ast.Node) (*ast.Ident, bool) {
	switch v := n.(type) {
	case *ast.Ident:
		return v, true
	case *ast.SelectorExpr:
		return v.Sel, true
	}
	return nil, false
}

// funcNodeID resolves the Node.ID of a top-level FuncDecl by looking up its
// declared *types.Func via TypesInfo.Defs. Methods carry a receiver so the
// lookup mirrors what addFunc registered.
func (s *buildState) funcNodeID(pkg parser.LivePackage, fd *ast.FuncDecl) string {
	if fd == nil || fd.Name == nil {
		return ""
	}
	def := pkg.TypesInfo.Defs[fd.Name]
	fn, ok := def.(*types.Func)
	if !ok {
		return ""
	}
	if id, ok := s.funcByObj[fn]; ok {
		return id
	}
	return ""
}

// funcStack is the tiny LIFO that carries the enclosing function id during a
// file walk. Using an explicit stack instead of recursion keeps the inspect
// closures stateless and easier to reason about.
type funcStack struct{ items []string }

func newFuncStack() *funcStack { return &funcStack{} }

func (st *funcStack) push(id string) { st.items = append(st.items, id) }

func (st *funcStack) pop() {
	if len(st.items) == 0 {
		return
	}
	st.items = st.items[:len(st.items)-1]
}

func (st *funcStack) top() string {
	if len(st.items) == 0 {
		return ""
	}
	return st.items[len(st.items)-1]
}

// Package store models a tiny key-value contract with two implementations
// so the resolver can exercise interface_impl expansion.
package store

// Store is the contract under test.
type Store interface {
	Get(key string) string
	Put(key, value string) error
}

// MemStore is an in-memory Store.
type MemStore struct {
	data map[string]string
}

// Get returns the stored value or "".
func (m *MemStore) Get(key string) string { return m.data[key] }

// Put stores value under key.
func (m *MemStore) Put(key, value string) error {
	if m.data == nil {
		m.data = map[string]string{}
	}
	m.data[key] = value
	return nil
}

// FileStore is a placeholder file-backed Store.
type FileStore struct {
	Path string
}

// Get always returns "".
func (f *FileStore) Get(key string) string { return "" }

// Put is a no-op.
func (f *FileStore) Put(key, value string) error { return nil }

package cache

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// runSweeper drives the periodic eviction of idle projects. It is started
// from New and shuts down when ctx is cancelled (Manager.Close).
func (m *manager) runSweeper(ctx context.Context) {
	defer m.wg.Done()

	ticker := time.NewTicker(m.sweepInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.sweep()
		}
	}
}

// sweep evicts every project whose LastAccessAt is older than IdleTTL. The
// directories are removed best-effort; failures are logged but do not stop
// the sweep cycle.
func (m *manager) sweep() {
	now := m.clock.Now()
	expired := m.collectExpired(now)
	for _, p := range expired {
		m.evict(p, now)
	}
}

// collectExpired snapshots the projects that should be reaped on this tick
// and removes them from the in-memory registry under the write lock so
// subsequent calls observe consistent state.
func (m *manager) collectExpired(now time.Time) []*Project {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	var expired []*Project
	for id, p := range m.projects {
		if now.Sub(p.Meta.LastAccessAt) >= m.idleTTL {
			expired = append(expired, p)
			delete(m.projects, id)
		}
	}
	return expired
}

// evict removes both directories of an already-unregistered project and logs
// the outcome.
func (m *manager) evict(p *Project, now time.Time) {
	if err := os.RemoveAll(p.SourcesDir); err != nil {
		m.logger.Warn("sweep: remove sources failed",
			slog.String("project_id", string(p.Meta.ID)),
			slog.String("path", p.SourcesDir),
			slog.String("error", err.Error()))
	}
	if err := os.RemoveAll(p.CacheDir); err != nil {
		m.logger.Warn("sweep: remove cache failed",
			slog.String("project_id", string(p.Meta.ID)),
			slog.String("path", p.CacheDir),
			slog.String("error", err.Error()))
	}
	m.logger.Info("sweep: project evicted",
		slog.String("project_id", string(p.Meta.ID)),
		slog.Time("last_access_at", p.Meta.LastAccessAt),
		slog.Duration("idle_for", now.Sub(p.Meta.LastAccessAt)))
}

// Compile-time guarantee that ProjectID is comparable so the projects map
// stays valid even if the underlying type changes.
var _ = map[domain.ProjectID]struct{}{}

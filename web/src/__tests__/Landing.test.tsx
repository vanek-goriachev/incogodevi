/**
 * Landing screen tests — covers drop-zone interaction, upload flow,
 * recent-projects list and error mapping (api-contract §1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';

import { Landing } from '../pages/Landing/Landing';
import { RouteSwitch, Router, useRouter } from '../app/Router';
import { ToastProvider } from '../app/Toasts';
import { ApiClient, ApiError } from '../api/client';
import type { Graph, ProjectMeta } from '../api/types';
import { RECENT_PROJECTS_KEY } from '../storage/keys';

interface RenderOptions {
  apiClient?: ApiClient;
  initialRecent?: unknown;
}

function AnalyzingProbe(): JSX.Element {
  const { state } = useRouter();
  return (
    <section data-testid="screen-analyzing">
      <span data-testid="analyzing-project">{state.projectName ?? ''}</span>
      <span data-testid="analyzing-id">{state.projectId ?? ''}</span>
    </section>
  );
}

function MainProbe(): JSX.Element {
  const { state } = useRouter();
  return (
    <section data-testid="screen-main">
      <span data-testid="main-project-name">{state.projectName ?? ''}</span>
    </section>
  );
}

function renderLanding(opts: RenderOptions = {}): {
  apiClient: ApiClient;
} {
  if (opts.initialRecent !== undefined) {
    window.localStorage.setItem(
      RECENT_PROJECTS_KEY,
      JSON.stringify(opts.initialRecent),
    );
  }
  const apiClient = opts.apiClient ?? new ApiClient();
  render(
    <ToastProvider autoDismissMs={50_000}>
      <Router initialRoute="landing">
        <RouteSwitch
          routes={{
            landing: <Landing apiClient={apiClient} />,
            analyzing: <AnalyzingProbe />,
            main: <MainProbe />,
          }}
        />
      </Router>
    </ToastProvider>,
  );
  return { apiClient };
}

function fakeMeta(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    project_id: 'pid-123',
    name: 'github.com/acme/example',
    uploaded_at: '2026-04-19T12:00:00Z',
    size_bytes: 100,
    file_count: 5,
    expires_at: '2026-04-19T12:30:00Z',
    ...overrides,
  };
}

function makeZip(name = 'project.zip', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: 'application/zip' });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('Landing', () => {
  it('renders drop-zone heading and requirements text', () => {
    renderLanding();
    expect(screen.getByTestId('landing-zone')).toBeInTheDocument();
    expect(screen.getByText('Drop a .zip here')).toBeInTheDocument();
    expect(screen.getByText('go.mod at archive root')).toBeInTheDocument();
    expect(screen.getByText(/up to 50 MB/i)).toBeInTheDocument();
  });

  it('clicking the drop-zone opens the file picker', async () => {
    const user = userEvent.setup();
    renderLanding();
    const input = screen.getByTestId('landing-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await user.click(screen.getByTestId('landing-zone'));
    expect(click).toHaveBeenCalled();
  });

  it('shows the dragging style while a file is dragged over the document', async () => {
    renderLanding();
    const dt = buildEmptyFileDataTransfer();
    fireEvent.dragEnter(document, { dataTransfer: dt });
    await waitFor(() => {
      expect(screen.getByTestId('landing-zone')).toHaveClass(
        'landing__zone--dragging',
      );
    });
    fireEvent.dragLeave(document, { dataTransfer: dt });
    await waitFor(() => {
      expect(screen.getByTestId('landing-zone')).not.toHaveClass(
        'landing__zone--dragging',
      );
    });
  });

  it('uploads a dropped file and navigates to analyzing on success', async () => {
    const apiClient = new ApiClient();
    const meta = fakeMeta();
    vi.spyOn(apiClient, 'uploadProject').mockResolvedValueOnce(meta);
    renderLanding({ apiClient });

    const file = makeZip('demo.zip', 256);
    const dt = buildFileDataTransfer(file);
    await act(async () => {
      fireEvent.drop(screen.getByTestId('landing-zone'), { dataTransfer: dt });
    });

    await waitFor(() => {
      expect(screen.getByTestId('screen-analyzing')).toBeInTheDocument();
    });
    expect(screen.getByTestId('analyzing-project')).toHaveTextContent(meta.name);

    const stored = JSON.parse(
      window.localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]',
    ) as Array<{ project_id: string }>;
    expect(stored[0]?.project_id).toBe(meta.project_id);
  });

  it('rejects non-zip selections client-side without calling the API', async () => {
    const apiClient = new ApiClient();
    const upload = vi.spyOn(apiClient, 'uploadProject');
    renderLanding({ apiClient });

    const txt = new File(['hello'], 'README.txt', { type: 'text/plain' });
    const dt = buildFileDataTransfer(txt);
    await act(async () => {
      fireEvent.drop(screen.getByTestId('landing-zone'), { dataTransfer: dt });
    });

    expect(upload).not.toHaveBeenCalled();
    const err = await screen.findByTestId('landing-error');
    expect(err).toHaveTextContent(/not a \.zip/i);
    expect(err).toHaveAttribute('data-error-code', 'not_a_zip');
  });

  it('rejects oversize files client-side', async () => {
    const apiClient = new ApiClient();
    const upload = vi.spyOn(apiClient, 'uploadProject');
    renderLanding({ apiClient });

    // 51 MB sparse file — only `.size` is read by the validator.
    const big = new File([], 'huge.zip', { type: 'application/zip' });
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    const dt = buildFileDataTransfer(big);
    await act(async () => {
      fireEvent.drop(screen.getByTestId('landing-zone'), { dataTransfer: dt });
    });

    expect(upload).not.toHaveBeenCalled();
    const err = await screen.findByTestId('landing-error');
    expect(err).toHaveAttribute('data-error-code', 'file_too_large_client');
  });

  it.each([
    ['go_mod_missing', /missing go\.mod/i],
    ['archive_too_large', /larger than 50 MB/i],
    ['zip_slip_detected', /unsafe paths/i],
    ['file_count_exceeded', /more than 10 000 files/i],
    ['unpacked_size_exceeded', /500 MB/i],
    ['invalid_zip', /not a valid zip/i],
  ])(
    'maps backend code %s to an inline message',
    async (code, expected) => {
      const apiClient = new ApiClient();
      vi.spyOn(apiClient, 'uploadProject').mockRejectedValueOnce(
        new ApiError(400, { code, message: 'server says no' }),
      );
      renderLanding({ apiClient });
      const dt = buildFileDataTransfer(makeZip());
      await act(async () => {
        fireEvent.drop(screen.getByTestId('landing-zone'), { dataTransfer: dt });
      });
      const err = await screen.findByTestId('landing-error');
      expect(err).toHaveTextContent(expected);
      expect(err).toHaveAttribute('data-error-code', code);
    },
  );

  it('shows an inline progress bar while uploading', async () => {
    const apiClient = new ApiClient();
    let progressCb:
      | ((loaded: number, total: number | undefined) => void)
      | undefined;
    let resolveUpload: ((meta: ProjectMeta) => void) | undefined;
    vi.spyOn(apiClient, 'uploadProject').mockImplementation(
      (_file, _name, onProgress) => {
        progressCb = onProgress;
        return new Promise<ProjectMeta>((resolve) => {
          resolveUpload = resolve;
        });
      },
    );
    renderLanding({ apiClient });

    const dt = buildFileDataTransfer(makeZip('demo.zip', 1000));
    await act(async () => {
      fireEvent.drop(screen.getByTestId('landing-zone'), { dataTransfer: dt });
    });
    await waitFor(() => {
      expect(progressCb).toBeDefined();
    });
    act(() => {
      progressCb?.(500, 1000);
    });
    const bar = await screen.findByTestId('landing-progress');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    act(() => {
      resolveUpload?.(fakeMeta());
    });
    await waitFor(() => {
      expect(screen.getByTestId('screen-analyzing')).toBeInTheDocument();
    });
  });

  describe('Recent projects', () => {
    const recent = [
      {
        project_id: 'old-1',
        name: 'github.com/acme/old-one',
        uploaded_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
      {
        project_id: 'old-2',
        name: 'playground',
        uploaded_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      },
    ];

    it('renders the persisted list with relative times', () => {
      renderLanding({ initialRecent: recent });
      const list = screen.getByTestId('landing-recent-list');
      expect(within(list).getByText('github.com/acme/old-one')).toBeInTheDocument();
      expect(within(list).getByText('playground')).toBeInTheDocument();
      expect(within(list).getByText(/h ago/)).toBeInTheDocument();
    });

    it('Restore navigates to main when the graph fetch succeeds', async () => {
      const apiClient = new ApiClient();
      const graph: Graph = {
        project_id: 'old-1',
        generated_at: '2026-04-19T12:00:00Z',
        aggregation: 'none',
        stats: { node_count: 0, edge_count: 0, by_kind: {}, dead_count: 0 },
        nodes: [],
        edges: [],
        warnings: [],
      };
      vi.spyOn(apiClient, 'getGraph').mockResolvedValueOnce(graph);
      renderLanding({ apiClient, initialRecent: recent });
      const user = userEvent.setup();
      await user.click(screen.getByTestId('landing-restore-old-1'));
      await waitFor(() => {
        expect(screen.getByTestId('screen-main')).toBeInTheDocument();
      });
      expect(screen.getByTestId('main-project-name')).toHaveTextContent(
        'github.com/acme/old-one',
      );
    });

    it('Restore on a 404 shows a toast and removes the entry', async () => {
      const apiClient = new ApiClient();
      vi.spyOn(apiClient, 'getGraph').mockRejectedValueOnce(
        new ApiError(404, { code: 'project_not_found', message: 'gone' }),
      );
      renderLanding({ apiClient, initialRecent: recent });
      const user = userEvent.setup();
      await user.click(screen.getByTestId('landing-restore-old-1'));
      await waitFor(() => {
        expect(
          screen.getByText(/project expired/i),
        ).toBeInTheDocument();
      });
      const stored = JSON.parse(
        window.localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]',
      ) as Array<{ project_id: string }>;
      expect(stored.find((p) => p.project_id === 'old-1')).toBeUndefined();
    });

    it('Forget removes the project from the list and purges its keys', async () => {
      // Seed a per-project key so we can assert it is gone afterwards.
      window.localStorage.setItem('go-viz:old-1:filters', '{}');
      renderLanding({ initialRecent: recent });
      const user = userEvent.setup();
      await user.click(screen.getByTestId('landing-forget-old-1'));
      await waitFor(() => {
        expect(
          screen.queryByTestId('landing-restore-old-1'),
        ).not.toBeInTheDocument();
      });
      expect(window.localStorage.getItem('go-viz:old-1:filters')).toBeNull();
      const stored = JSON.parse(
        window.localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]',
      ) as Array<{ project_id: string }>;
      expect(stored.map((p) => p.project_id)).toEqual(['old-2']);
    });

    it('hides the recent section when the list is empty', () => {
      renderLanding();
      expect(screen.queryByTestId('landing-recent-list')).not.toBeInTheDocument();
    });
  });
});

function buildEmptyFileDataTransfer(): DataTransfer {
  return {
    files: { length: 0, item: () => null } as unknown as FileList,
    items: [],
    types: ['Files'],
    dropEffect: 'copy',
    effectAllowed: 'all',
    getData: () => '',
    setData: () => {},
    clearData: () => {},
    setDragImage: () => {},
  } as unknown as DataTransfer;
}

function buildFileDataTransfer(file: File): DataTransfer {
  // jsdom's DataTransfer cannot append `files`; we expose a minimal shim that
  // satisfies the read paths used by the Landing component.
  const list = {
    length: 1,
    0: file,
    item: (idx: number) => (idx === 0 ? file : null),
    [Symbol.iterator]: function* () {
      yield file;
    },
  } as unknown as FileList;
  const items = [
    {
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
    },
  ];
  return {
    files: list,
    items,
    types: ['Files'],
    dropEffect: 'copy',
    effectAllowed: 'all',
    getData: () => '',
    setData: () => {},
    clearData: () => {},
    setDragImage: () => {},
  } as unknown as DataTransfer;
}


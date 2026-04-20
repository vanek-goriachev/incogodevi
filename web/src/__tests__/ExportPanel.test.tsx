/**
 * Component tests for the right-rail Export panel (T24, FR-21/FR-22).
 *
 * Cytoscape's `cy.png` and `cy.svg` are mocked out — the panel's job is to
 * call them with the right shape and to push the result into the browser
 * download path. The download path itself is mocked through `URL.createObjectURL`
 * so jsdom is happy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Core } from 'cytoscape';

import { ExportPanel } from '../pages/Main/panels/ExportPanel';

interface FakeCy {
  png: ReturnType<typeof vi.fn>;
  svg: ReturnType<typeof vi.fn>;
}

function makeCy(overrides: Partial<FakeCy> = {}): { core: Core; spy: FakeCy } {
  const spy: FakeCy = {
    png: vi.fn(() => new Blob(['png-bytes'], { type: 'image/png' })),
    svg: vi.fn(() => '<svg xmlns="http://www.w3.org/2000/svg" />'),
    ...overrides,
  };
  return { core: spy as unknown as Core, spy };
}

let createObjectUrl: ReturnType<typeof vi.spyOn>;
let revokeObjectUrl: ReturnType<typeof vi.spyOn>;
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createObjectUrl = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValue('blob:http://localhost/test');
  revokeObjectUrl = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation(() => undefined);
  // jsdom does not implement HTMLAnchorElement.click() side effects; spy so we
  // can assert the panel actually triggered a click without navigation noise.
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  createObjectUrl.mockRestore();
  revokeObjectUrl.mockRestore();
  clickSpy.mockRestore();
  vi.useRealTimers();
});

describe('<ExportPanel />', () => {
  it('renders both buttons disabled when cy is null', () => {
    render(<ExportPanel cy={null} projectName="demo" backgroundColor="#fff" />);
    const png = screen.getByTestId('export-panel-png');
    const svg = screen.getByTestId('export-panel-svg');
    expect(png).toBeDisabled();
    expect(svg).toBeDisabled();
  });

  it('calls cy.png with viewport scale 2 when PNG is clicked', async () => {
    const { core, spy } = makeCy();
    const user = userEvent.setup();
    render(<ExportPanel cy={core} projectName="demo" backgroundColor="#0f172a" />);

    await user.click(screen.getByTestId('export-panel-png'));

    expect(spy.png).toHaveBeenCalledOnce();
    const opts = spy.png.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts['output']).toBe('blob');
    expect(opts['scale']).toBe(2);
    expect(opts['full']).toBe(false);
    expect(opts['bg']).toBe('#0f172a');

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalled();
    });
    expect(createObjectUrl).toHaveBeenCalledOnce();
  });

  it('calls cy.svg with full=true when SVG is clicked', async () => {
    const { core, spy } = makeCy();
    const user = userEvent.setup();
    render(<ExportPanel cy={core} projectName="demo" backgroundColor="#fafafa" />);

    await user.click(screen.getByTestId('export-panel-svg'));

    expect(spy.svg).toHaveBeenCalledOnce();
    const opts = spy.svg.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts['full']).toBe(true);
    expect(opts['bg']).toBe('#fafafa');

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalled();
    });
  });

  it('reports an error toast when cy.png throws', async () => {
    const { core } = makeCy({
      png: vi.fn(() => {
        throw new Error('renderer not ready');
      }),
    });
    const onError = vi.fn();
    const user = userEvent.setup();
    render(
      <ExportPanel
        cy={core}
        projectName="demo"
        backgroundColor="#fff"
        onError={onError}
      />,
    );

    await user.click(screen.getByTestId('export-panel-png'));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('Export PNG failed'),
      );
    });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('uses sanitised project name in the download filename', async () => {
    const { core } = makeCy();
    const user = userEvent.setup();
    const setAttribute = vi.spyOn(HTMLAnchorElement.prototype, 'download', 'set');

    render(
      <ExportPanel cy={core} projectName="github.com/acme/x" backgroundColor="#fff" />,
    );
    await user.click(screen.getByTestId('export-panel-png'));

    await waitFor(() => {
      expect(setAttribute).toHaveBeenCalled();
    });
    const captured = setAttribute.mock.calls.map((call) => call[0]).join('|');
    expect(captured).toMatch(/^github.com_acme_x-graph-\d{8}-\d{6}\.png$/);

    setAttribute.mockRestore();
  });
});

/**
 * Sanity tests for the Cytoscape stylesheet generator. We do not exercise
 * Cytoscape itself here — those checks live in `GraphCanvas.test.tsx`. The
 * goal is to lock down the per-kind selectors and overlays so a regression
 * in `graph-styles.ts` shows up immediately.
 */

import { describe, expect, it } from 'vitest';

import {
  EDGE_KIND_STYLES,
  NODE_KIND_ORDER,
  NODE_KIND_STYLES,
  buildStylesheet,
  readThemeTokens,
  type ThemeTokens,
} from '../pages/Main/graph-styles';

const SAMPLE_THEME: ThemeTokens = {
  fg: '#0f172a',
  fgMuted: '#475569',
  bg: '#ffffff',
  bgElevated: '#f8fafc',
  accent: '#3b82f6',
  border: '#cbd5f5',
};

describe('NODE_KIND_STYLES', () => {
  it('defines a style for every node kind', () => {
    for (const kind of NODE_KIND_ORDER) {
      const style = NODE_KIND_STYLES[kind];
      expect(style).toBeDefined();
      expect(style.shape).not.toBe('');
      expect(style.fill).toMatch(/^#/);
      expect(style.border).toMatch(/^#/);
      expect(style.borderWidth).toBeGreaterThan(0);
      expect(style.width).toBeGreaterThan(0);
      expect(style.height).toBeGreaterThan(0);
    }
  });

  it('uses the design.md §5.1 shapes', () => {
    expect(NODE_KIND_STYLES.package.shape).toBe('round-rectangle');
    expect(NODE_KIND_STYLES.struct.shape).toBe('rectangle');
    expect(NODE_KIND_STYLES.interface.shape).toBe('diamond');
    expect(NODE_KIND_STYLES.func.shape).toBe('ellipse');
    expect(NODE_KIND_STYLES.method.shape).toBe('ellipse');
    expect(NODE_KIND_STYLES.var.shape).toBe('hexagon');
    expect(NODE_KIND_STYLES.const.shape).toBe('hexagon');
  });
});

describe('EDGE_KIND_STYLES', () => {
  it('defines a style for every edge kind', () => {
    const expected = ['imports', 'contains', 'calls', 'embeds', 'implements', 'references'];
    for (const kind of expected) {
      const style = EDGE_KIND_STYLES[kind as keyof typeof EDGE_KIND_STYLES];
      expect(style).toBeDefined();
      expect(['solid', 'dashed', 'dotted']).toContain(style.lineStyle);
      expect(style.width).toBeGreaterThan(0);
    }
  });

  it('uses dashed for implements and dotted for references', () => {
    expect(EDGE_KIND_STYLES.implements.lineStyle).toBe('dashed');
    expect(EDGE_KIND_STYLES.references.lineStyle).toBe('dotted');
  });
});

describe('buildStylesheet', () => {
  it('emits a per-kind selector for every node kind', () => {
    const sheet = buildStylesheet(SAMPLE_THEME);
    for (const kind of NODE_KIND_ORDER) {
      expect(sheet.some((s) => s.selector === `node[kind="${kind}"]`)).toBe(true);
    }
  });

  it('emits a per-kind selector for every edge kind', () => {
    const sheet = buildStylesheet(SAMPLE_THEME);
    for (const kind of Object.keys(EDGE_KIND_STYLES)) {
      expect(sheet.some((s) => s.selector === `edge[kind="${kind}"]`)).toBe(true);
    }
  });

  it('attaches the dead and entry overlays', () => {
    const sheet = buildStylesheet(SAMPLE_THEME);
    expect(sheet.some((s) => s.selector === 'node.dead')).toBe(true);
    expect(sheet.some((s) => s.selector === 'node.entry')).toBe(true);
  });

  it('reads label/colour from the theme tokens', () => {
    const baseRule = buildStylesheet(SAMPLE_THEME).find((s) => s.selector === 'node');
    expect(baseRule).toBeDefined();
    if (baseRule === undefined) {
      return;
    }
    const style = baseRule.style as Record<string, unknown>;
    expect(style.color).toBe(SAMPLE_THEME.fg);
    expect(style.label).toBe('data(name)');
  });
});

describe('readThemeTokens', () => {
  it('falls back to the design defaults when no CSS variables are set', () => {
    const tokens = readThemeTokens(document.createElement('div'));
    expect(tokens.fg).toBe('#0f172a');
    expect(tokens.bg).toBe('#ffffff');
    expect(tokens.accent).toBe('#3b82f6');
  });
});

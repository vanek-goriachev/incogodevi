/**
 * Three-column layout skeleton — left rail (240 px) / graph (flex) / right
 * rail (300 px), per `docs/design.md` §3.3. Used as the base for the Main
 * screen in T20+. For T17 it is exported but only renders empty rails.
 */

import type { JSX, ReactNode } from 'react';

export interface LayoutProps {
  topBar?: ReactNode;
  leftRail?: ReactNode;
  rightRail?: ReactNode;
  children?: ReactNode;
}

export function Layout({ topBar, leftRail, rightRail, children }: LayoutProps): JSX.Element {
  return (
    <div className="layout">
      {topBar !== undefined && (
        <header className="layout__top-bar" data-testid="layout-top-bar">
          {topBar}
        </header>
      )}
      <div className="layout__body">
        <aside className="layout__rail layout__rail--left" data-testid="layout-left-rail">
          {leftRail}
        </aside>
        <main className="layout__main" data-testid="layout-main">
          {children}
        </main>
        <aside className="layout__rail layout__rail--right" data-testid="layout-right-rail">
          {rightRail}
        </aside>
      </div>
    </div>
  );
}

/**
 * Ambient module declaration for the `cytoscape-cola` layout extension.
 *
 * The package ships JavaScript without bundled type definitions and
 * @types/cytoscape-cola does not exist on npm. The extension is a plain
 * `cytoscape.Ext` registrar; a minimal `default: cytoscape.Ext`
 * declaration is sufficient for consumers that only call `cytoscape.use(cola)`
 * and pass `name: 'cola'` plus runtime options to `cy.layout(...)`.
 */

declare module 'cytoscape-cola' {
  import type { Ext } from 'cytoscape';
  const cola: Ext;
  export default cola;
}

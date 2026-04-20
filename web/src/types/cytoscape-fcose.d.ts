/**
 * Ambient module declaration for the `cytoscape-fcose` layout extension.
 *
 * The package ships ESM JavaScript without bundled type definitions and
 * @types/cytoscape-fcose does not exist on npm. The extension is a plain
 * `cytoscape.Ext` registrar that returns nothing of interest to consumers,
 * so a minimal `default: cytoscape.Ext` declaration is sufficient.
 */

declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';
  const fcose: Ext;
  export default fcose;
}

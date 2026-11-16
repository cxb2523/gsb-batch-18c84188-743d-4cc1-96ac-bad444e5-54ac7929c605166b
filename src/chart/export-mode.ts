/*
 * Whether a card is being pictured for the export menu.
 *
 * The export redraws the card once with this set, so a chart can leave out what the picture
 * should not carry (readings outside a zoomed window, marks beyond the visible span). The flag
 * lives here, apart from the menu and the charts, so either can read it without importing the
 * other (and without a module cycle).
 */

const exporting = new WeakSet<HTMLElement>();

/** The card is about to be pictured: draw for the export. */
export function beginExport(host: HTMLElement): void {
  exporting.add(host);
}

/** The picture is taken: draw as usual again. */
export function endExport(host: HTMLElement): void {
  exporting.delete(host);
}

/** Whether the card is drawing itself for an exported picture. */
export function isExporting(host: HTMLElement): boolean {
  return exporting.has(host);
}

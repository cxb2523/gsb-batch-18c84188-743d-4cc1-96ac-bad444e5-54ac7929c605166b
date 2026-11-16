/**
 * Synchronisation of the texture painter's pixel caches with a paint canvas
 * after a history action (undo / redo of a PaintStrokeCommand).
 *
 * Every painter writes dabs into `ProjectionPainter.imageData` (the cache used
 * for colour picking and alpha blending) and then flushes that cache to the
 * visible paint canvas.  Undo/redo only rewrites the canvas, so the cache, and
 * the preview material that displays the canvas' texture, have to be brought
 * back in step explicitly.  This module holds that logic in one place and is
 * free of DOM / three.js dependencies so it can be exercised in plain Node.
 */

/**
 * Returns true when two images share the same dimensions.
 * @param {{width:number,height:number}} a
 * @param {{width:number,height:number}} b
 */
export function isSameSize(a, b) {
  return !!a && !!b && a.width === b.width && a.height === b.height;
}

/**
 * Replace the projection painter's working pixel cache with a fresh copy of
 * `imageData` when its canvas is the canvas that was just rewritten.
 *
 * The copy is deliberate: history commands retain their own ImageData, so the
 * cache must not alias a buffer that later history entries may mutate.
 *
 * Safe no-op when:
 *  - no projection painter / canvas exists,
 *  - the projection painter is bound to a different canvas (another paint map),
 *  - the dimensions do not match.
 *
 * @param {object} projectionPainter
 * @param {HTMLCanvasElement} canvas
 * @param {ImageData} imageData
 * @returns {boolean} whether the cache was replaced
 */
export function syncProjectionCache(projectionPainter, canvas, imageData) {
  if (!projectionPainter || !canvas || !imageData) return false;
  if (projectionPainter.canvas !== canvas) return false;
  if (!isSameSize(projectionPainter.imageData ?? canvas, imageData)) return false;

  projectionPainter.imageData = new ImageData(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height
  );

  return true;
}

/**
 * Force a material to re-upload the shared texture when it is the texture
 * currently shown in the viewport.  The object's `material` is whichever
 * material is actively assigned (the preview material while a paint session
 * is active).
 *
 * @param {THREE.Material|undefined|null} activeMaterial
 * @param {THREE.Texture} texture
 * @returns {boolean} whether the displayed material was refreshed
 */
export function refreshPreviewMaterial(activeMaterial, texture) {
  if (!activeMaterial || !texture) return false;
  if (activeMaterial.map !== texture) return false;

  activeMaterial.needsUpdate = true;
  return true;
}

/**
 * Apply a history ImageData to every state that must follow the paint canvas
 * inside an active paint session:
 *
 *  1. the projection painter's pixel cache (only when it owns this canvas),
 *  2. the preview material currently displaying this texture.
 *
 * Map isolation: only the entry matching `paintMap` is touched.  Entries of
 * other paint maps (their canvases, textures and caches) are never read or
 * written.
 *
 * Safe no-op (returns false, never throws) when the paint session is inactive,
 * the painter is bound to another object, the map entry does not exist, or the
 * history image dimensions do not match the canvas.
 *
 * @param {object} texturePainter
 * @param {THREE.Object3D} object
 * @param {string} paintMap
 * @param {ImageData} imageData
 * @returns {boolean} whether the painter state was synchronised
 */
export function syncPainterPixels(texturePainter, object, paintMap, imageData) {
  if (!texturePainter || !object || !paintMap || !imageData) return false;
  if (!texturePainter.isActive || texturePainter.object !== object) return false;

  const entry = texturePainter._maps?.[paintMap];
  const canvas = entry?.paintCanvas;
  const texture = entry?.texture;

  if (!canvas || !texture) return false;
  if (!isSameSize(canvas, imageData)) return false;

  const cacheSynced = syncProjectionCache(
    texturePainter.projectionPainter,
    canvas,
    imageData
  );

  const previewRefreshed = refreshPreviewMaterial(object.material, texture);

  return cacheSynced || previewRefreshed;
}

import Konva from 'konva'

/**
 * Geometry written back to a sprite after a transformer interaction.
 */
export interface SpriteTransformUpdate {
  id: string
  position: { x: number; y: number }
  scale: { x: string; y: string }
  rotation: Rotation
}

/**
 * Minimal shape of a Konva node that carries transformable geometry.
 * Kept as a structural type so tests can build lightweight fakes instead of
 * mounting real Konva nodes (which need a canvas implementation).
 */
export interface TransformableNode {
  id(): string
  x(): number
  y(): number
  scaleX(): number
  scaleY(): number
  rotation(): number
}

/**
 * Normalise any angle into the 0..359 degree range used by `Rotation`.
 */
export const normaliseRotation = (rotation: number): Rotation =>
  (((Math.round(rotation) % 360) + 360) % 360) as Rotation

/**
 * Read the geometry the transformer wrote on a node and shape it into the
 * update persisted for the matching sprite.
 */
export const readNodeTransform = (node: TransformableNode): SpriteTransformUpdate => ({
  id: node.id(),
  position: {
    x: Number(node.x().toFixed(0)),
    y: Number(node.y().toFixed(0)),
  },
  scale: {
    x: node.scaleX().toFixed(2),
    y: node.scaleY().toFixed(2),
  },
  rotation: normaliseRotation(node.rotation()),
})

/**
 * Resolve the nodes the single selection transformer must attach to:
 * every selected sprite that is not locked, in selection order.
 * Locked sprites stay outside the transformer so their geometry can never be
 * changed by a scale or rotation interaction.
 */
export const resolveTransformerNodes = (
  selectedIds: string[],
  datas: SpriteData[],
  registry: ReadonlyMap<string, Konva.Node>,
): Konva.Node[] => {
  const lockedIds = new Set(datas.filter((data) => data.locked).map((data) => data.id))
  return selectedIds
    .filter((id) => !lockedIds.has(id))
    .map((id) => registry.get(id))
    .filter((node): node is Konva.Node => Boolean(node))
}

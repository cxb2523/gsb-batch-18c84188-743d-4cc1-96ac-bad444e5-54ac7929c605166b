import React, { useContext, useEffect, useRef, useState } from 'react'
import Konva from 'konva'
import { Transformer } from 'react-konva'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  applySpriteTransformsAction,
  selectedSpriteIdsState,
  selectedSpritesState,
} from '../../../state/SpritesState'
import { CanvasNodesContext } from '../CanvasNodesContext'
import { readNodeTransform, resolveTransformerNodes } from './transform'

/**
 * The single transformer that covers every editable (unlocked) selected
 * sprite at once. Attaching several nodes to one Konva.Transformer makes it
 * render one bounding box over the whole selection and apply the very same
 * delta transform to every node on scale, rotate and group drag, so the
 * sprites keep their relative layout. On transform end the resulting
 * geometry is written back to all affected sprites together; the selection
 * itself is preserved.
 */
export const SelectionTransformer = (): React.JSX.Element | null => {
  const transformerRef = useRef<Konva.Transformer>(null)
  const { nodesRef } = useContext(CanvasNodesContext)
  const selectedIds = useAtomValue(selectedSpriteIdsState)
  const selectedSprites = useAtomValue(selectedSpritesState)
  const applySpriteTransforms = useSetAtom(applySpriteTransformsAction)
  const [nodes, setNodes] = useState<Konva.Node[]>([])

  // Resolve the attached nodes outside of render: the node registry is a ref
  // that changes without notifying React, so it must only be read in effects
  // and event handlers.
  useEffect(() => {
    const nextNodes = resolveTransformerNodes(selectedIds, selectedSprites.datas, nodesRef.current)
    setNodes((currentNodes) =>
      currentNodes.length === nextNodes.length &&
      currentNodes.every((node, i) => node === nextNodes[i])
        ? currentNodes
        : nextNodes,
    )
  }, [selectedIds, selectedSprites.datas, nodesRef])

  useEffect(() => {
    const transformer = transformerRef.current
    if (!transformer) return

    transformer.nodes(nodes)
    transformer.getLayer()?.batchDraw()
  }, [nodes])

  if (nodes.length === 0) return null

  const onTransformEnd = () => {
    applySpriteTransforms(
      transformerRef.current!.nodes().map((node) => readNodeTransform(node as Konva.Node)),
    )
  }

  return (
    <Transformer
      ref={transformerRef}
      rotationSnaps={[0, 90, 180, -90]}
      rotationSnapTolerance={2}
      borderDash={[3, 3]}
      anchorSize={8}
      centeredScaling={true}
      shouldOverdrawWholeArea={true}
      // Keep the legacy single-selection behaviour: the box follows the
      // sprite's own rotation. With several nodes konva always manages the
      // shared box rotation regardless of this flag.
      useSingleNodeRotation={nodes.length === 1}
      anchorCornerRadius={1}
      onTransformEnd={onTransformEnd}
    />
  )
}

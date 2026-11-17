import useImage from 'use-image'
import { Image as KonvaImage } from 'react-konva'
import React, { useContext, useEffect } from 'react'
import { KonvaNodeEvents } from 'react-konva'
import { ImageConfig } from 'konva/lib/shapes/Image'
import Konva from 'konva'
import { useAtom } from 'jotai'
import {
  selectedSpriteIdsState,
  spriteDatasWithId,
  spriteMetasWithId,
} from '../../../state/SpritesState'
import { noop } from 'lodash'
import { CanvasNodesContext } from '../CanvasNodesContext'

interface Props extends KonvaNodeEvents, Partial<ImageConfig> {
  id: string
}

export const CanvasSprite = ({ id, ...props }: Props) => {
  const [selectedIds, setSelectedIds] = useAtom(selectedSpriteIdsState)
  const [spriteData, setSpriteData] = useAtom(spriteDatasWithId(id))
  const [spriteMeta, setSpriteMeta] = useAtom(spriteMetasWithId(id))
  const { nodesRef } = useContext(CanvasNodesContext)

  const { scale, rotation, position, opacity, locked } = spriteData
  const { src, isDragging } = spriteMeta

  const [htmlImageElement] = useImage(src)
  const { width, height } = htmlImageElement || { width: 0, height: 0 }

  const scaleX = Number(scale.x)
  const scaleY = Number(scale.y)

  // When image loads, get the width and height, needed for weight calculations
  useEffect(() => {
    if (!width || !height) return
    setSpriteMeta((meta) => ({ ...meta, spriteWidth: width, spriteHeight: height }))
  }, [width, height, setSpriteMeta])

  // Register the live node so the single selection transformer can attach to
  // it together with the other selected sprites. Kept identity-stable so React
  // does not detach and re-attach it on every render.
  const setNode = React.useCallback(
    (node: Konva.Node | null) => {
      if (node) {
        nodesRef.current.set(id, node)
      } else {
        nodesRef.current.delete(id)
      }
    },
    [id, nodesRef],
  )

  const onDragStart = (_e: Konva.KonvaEventObject<DragEvent>) => {
    setSpriteMeta((meta) => ({ ...meta, isDragging: true }))
  }

  const onDragEnd = (e: Konva.KonvaEventObject<DragEvent>) => {
    setSpriteData((data) => ({
      ...data,
      position: {
        x: Number(e.target.x().toFixed(0)),
        y: Number(e.target.y().toFixed(0)),
        z: Number(Number(data.position.z).toFixed(0)),
      },
    }))
    setSpriteMeta((meta) => ({ ...meta, isDragging: false }))
  }

  const onDoubleClick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    onClick(e)
  }

  const onClick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    // prevent deselection by clicking on the canvas
    e.cancelBubble = true

    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((selectedId) => selectedId !== id))
    } else if (e.evt.shiftKey) {
      setSelectedIds([...selectedIds, id])
    } else {
      setSelectedIds([id])
    }
  }

  // Locked sprites can never be dragged, even while selected. During a
  // multi-selection transform they are also excluded from the transformer,
  // so their geometry stays untouched.
  const draggable = !locked

  return (
    <KonvaImage
      // @ts-ignore
      ref={setNode}
      draggable={draggable}
      shadowOffsetX={isDragging ? 10 : 5}
      shadowOffsetY={isDragging ? 10 : 5}
      shadowColor="rgba(0, 0, 0, 0.5)"
      shadowBlur={10}
      shadowOpacity={0.6}
      {...props}
      {...spriteMeta}
      id={id}
      image={htmlImageElement}
      x={position.x}
      y={position.y}
      offsetX={width / 2}
      offsetY={height / 2}
      rotation={rotation}
      scaleX={scaleX}
      scaleY={scaleY}
      opacity={opacity}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={locked ? noop : onClick}
      onDblClick={onDoubleClick}
      onTap={locked ? noop : onClick}
      onDblTap={onDoubleClick}
    />
  )
}

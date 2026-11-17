import { MutableRefObject, createContext, createRef } from 'react'
import Konva from 'konva'

export interface CanvasNodesContextProps {
  /**
   * Maps every rendered sprite id to its live Konva node, so a single
   * transformer can attach to all selected sprites at once.
   */
  nodesRef: MutableRefObject<Map<string, Konva.Node>>
}

export const CanvasNodesContext = createContext<CanvasNodesContextProps>({
  nodesRef: createRef<Map<string, Konva.Node>>() as MutableRefObject<Map<string, Konva.Node>>,
})

CanvasNodesContext.displayName = 'CanvasNodesContext'

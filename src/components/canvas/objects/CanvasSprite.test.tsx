import { cleanup, render } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CanvasNodesContext, CanvasNodesContextProps } from '../CanvasNodesContext'
import { selectedSpriteIdsState, spriteDatasWithId } from '../../../state/SpritesState'
import { SpriteData } from '../../../model/SpriteData'

// No canvas 2d context is available in happy-dom, so replace the Konva image
// with a plain element that still records the draggable prop.
const renderedImages: Array<{ id: string; draggable: boolean }> = []

vi.mock('use-image', () => ({ default: () => [null] }))

vi.mock('react-konva', () => ({
  Image: (props: { id: string; draggable: boolean }) => {
    renderedImages.push({ id: props.id, draggable: props.draggable })
    return null
  },
}))

const { CanvasSprite } = await import('./CanvasSprite')

const spriteData = (id: string, locked: boolean): SpriteData => ({
  ...SpriteData.default(),
  id,
  locked,
  position: { x: 10, y: 20, z: 0 },
})

const Harness = ({ id }: { id: string }) => {
  const contextValue = React.useMemo<CanvasNodesContextProps>(
    () => ({
      nodesRef: { current: new Map() } as CanvasNodesContextProps['nodesRef'],
    }),
    [],
  )
  return (
    <CanvasNodesContext.Provider value={contextValue}>
      <CanvasSprite id={id} />
    </CanvasNodesContext.Provider>
  )
}

const renderSprite = (store: ReturnType<typeof createStore>, id: string) =>
  render(
    <Provider store={store}>
      <Harness id={id} />
    </Provider>,
  )

describe('CanvasSprite', () => {
  afterEach(() => {
    cleanup()
    renderedImages.length = 0
  })

  it('keeps an unlocked sprite draggable', () => {
    const store = createStore()
    store.set(spriteDatasWithId('free'), spriteData('free', false))

    renderSprite(store, 'free')

    expect(renderedImages).toHaveLength(1)
    expect(renderedImages[0].draggable).toBe(true)
  })

  it('makes a locked sprite non-draggable even while selected', () => {
    const store = createStore()
    store.set(spriteDatasWithId('locked'), spriteData('locked', true))
    store.set(selectedSpriteIdsState, ['locked'])

    renderSprite(store, 'locked')

    expect(renderedImages).toHaveLength(1)
    expect(renderedImages[0]).toMatchObject({ id: 'locked', draggable: false })
  })
})

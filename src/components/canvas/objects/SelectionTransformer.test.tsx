import { cleanup, render, waitFor } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasNodesContext, CanvasNodesContextProps } from '../CanvasNodesContext'
import { selectedSpriteIdsState, spriteDatasWithId } from '../../../state/SpritesState'
import { SpriteData } from '../../../model/SpriteData'

// react-konva's real Transformer needs a canvas 2d context that happy-dom does
// not provide, so capture a lightweight stand-in instead.
const transformerInstances: Array<{
  nodes: (nodes?: unknown[]) => unknown[]
  getLayer: () => null
  props: Record<string, unknown>
}> = []

vi.mock('react-konva', () => ({
  Transformer: React.forwardRef((props: Record<string, unknown>, ref) => {
    const attached: unknown[] = []
    const instance = {
      nodes: (next?: unknown[]) => {
        if (next) {
          attached.length = 0
          attached.push(...next)
        }
        return attached
      },
      getLayer: () => null,
      props,
    }
    React.useImperativeHandle(ref, () => instance)
    // No dependency array: on every render the cleanup unregisters the
    // previous render's instance and the effect registers the current one, so
    // the array always ends up holding the mounted transformer.
    React.useEffect(() => {
      transformerInstances.push(instance)
      return () => {
        const index = transformerInstances.indexOf(instance)
        if (index >= 0) transformerInstances.splice(index, 1)
      }
    })
    return null
  }),
}))

// Imported after the mock is registered.
const { SelectionTransformer } = await import('./SelectionTransformer')

const makeNode = (id: string) => ({
  id: () => id,
  x: () => (id === 'a' ? 100 : 200),
  y: () => (id === 'a' ? 200 : 400),
  scaleX: () => 2,
  scaleY: () => 3,
  rotation: () => -90,
})

const spriteData = (id: string, locked = false): SpriteData => ({
  ...SpriteData.default(),
  id,
  locked,
  position: { x: 0, y: 0, z: 1 },
})

const Harness = ({ registry }: { registry: Map<string, unknown> }) => {
  const contextValue = React.useMemo<CanvasNodesContextProps>(
    () => ({ nodesRef: { current: registry } as CanvasNodesContextProps['nodesRef'] }),
    [registry],
  )
  return (
    <CanvasNodesContext.Provider value={contextValue}>
      <SelectionTransformer />
    </CanvasNodesContext.Provider>
  )
}

const renderTransformer = (store: ReturnType<typeof createStore>, registry: Map<string, unknown>) =>
  render(
    <Provider store={store}>
      <Harness registry={registry} />
    </Provider>,
  )

describe('SelectionTransformer', () => {
  beforeEach(() => {
    transformerInstances.length = 0
  })

  afterEach(() => {
    cleanup()
    transformerInstances.length = 0
    vi.clearAllMocks()
  })

  it('renders exactly one transformer attached to every selected sprite', async () => {
    const store = createStore()
    store.set(spriteDatasWithId('a'), spriteData('a'))
    store.set(spriteDatasWithId('b'), spriteData('b'))
    store.set(selectedSpriteIdsState, ['a', 'b'])
    const registry = new Map([
      ['a', makeNode('a')],
      ['b', makeNode('b')],
    ])

    renderTransformer(store, registry)

    // The first effect resolves the nodes and the second one attaches them;
    // wait for the mounted transformer to carry the full selection.
    await waitFor(() => {
      expect(transformerInstances).toHaveLength(1)
      const attached = transformerInstances[0].nodes() as Array<{ id: () => string }>
      expect(attached.map((node) => node.id())).toEqual(['a', 'b'])
    })
  })

  it('never attaches locked sprites and renders nothing when all are locked', async () => {
    const store = createStore()
    store.set(spriteDatasWithId('locked'), spriteData('locked', true))
    store.set(selectedSpriteIdsState, ['locked'])
    const registry = new Map([['locked', makeNode('locked')]])

    renderTransformer(store, registry)

    await waitFor(() => expect(transformerInstances).toHaveLength(0))
  })

  it('attaches only the editable sprites when the selection mixes locked and free ones', async () => {
    const store = createStore()
    store.set(spriteDatasWithId('a'), spriteData('a'))
    store.set(spriteDatasWithId('locked'), spriteData('locked', true))
    store.set(spriteDatasWithId('b'), spriteData('b'))
    store.set(selectedSpriteIdsState, ['a', 'locked', 'b'])
    const registry = new Map([
      ['a', makeNode('a')],
      ['locked', makeNode('locked')],
      ['b', makeNode('b')],
    ])

    renderTransformer(store, registry)

    await waitFor(() => {
      expect(transformerInstances).toHaveLength(1)
      const attached = transformerInstances[0].nodes() as Array<{ id: () => string }>
      expect(attached.map((node) => node.id())).toEqual(['a', 'b'])
    })
  })

  it('writes the transform back to every attached sprite on transform end and keeps the selection', async () => {
    const store = createStore()
    store.set(spriteDatasWithId('a'), spriteData('a'))
    store.set(spriteDatasWithId('b'), spriteData('b'))
    store.set(selectedSpriteIdsState, ['a', 'b'])
    const registry = new Map([
      ['a', makeNode('a')],
      ['b', makeNode('b')],
    ])

    renderTransformer(store, registry)

    await waitFor(() => expect(transformerInstances).toHaveLength(1))
    const onTransformEnd = transformerInstances[0].props.onTransformEnd as () => void
    onTransformEnd()

    expect(store.get(spriteDatasWithId('a'))).toMatchObject({
      position: { x: 100, y: 200, z: 1 },
      scale: { x: '2.00', y: '3.00', z: '1.0' },
      rotation: 270,
    })
    expect(store.get(spriteDatasWithId('b'))).toMatchObject({
      position: { x: 200, y: 400, z: 1 },
      scale: { x: '2.00', y: '3.00', z: '1.0' },
      rotation: 270,
    })
    // Multi-selection remains active for follow-up operations.
    expect(store.get(selectedSpriteIdsState)).toEqual(['a', 'b'])
  })

  it('does not change locked sprite geometry when part of the selection', async () => {
    const store = createStore()
    const locked = spriteData('locked', true)
    store.set(spriteDatasWithId('locked'), locked)
    store.set(spriteDatasWithId('a'), spriteData('a'))
    store.set(selectedSpriteIdsState, ['locked', 'a'])
    const registry = new Map([
      ['locked', makeNode('locked')],
      ['a', makeNode('a')],
    ])

    renderTransformer(store, registry)

    await waitFor(() => expect(transformerInstances).toHaveLength(1))
    const onTransformEnd = transformerInstances[0].props.onTransformEnd as () => void
    onTransformEnd()

    expect(store.get(spriteDatasWithId('locked'))).toEqual(locked)
    expect(store.get(spriteDatasWithId('a'))).toMatchObject({ rotation: 270 })
    expect(store.get(selectedSpriteIdsState)).toEqual(['locked', 'a'])
  })
})

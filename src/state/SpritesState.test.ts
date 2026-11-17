import { createStore } from 'jotai'
import { describe, expect, it } from 'vitest'

import { SpriteData } from '../model/SpriteData'
import { SpriteMeta } from '../model/SpriteMeta'
import {
  addSpriteAction,
  allSpritesState,
  applySpriteTransformsAction,
  deleteSpritesAction,
  selectedSpriteIdsState,
  selectedSpritesState,
  spriteDatasWithId,
  spriteIdsState,
  spriteMetasWithId,
} from './SpritesState'

const spriteData = (id: string): SpriteData => ({ ...SpriteData.default(), id, relativePath: id })
const spriteMeta = (id: string): SpriteMeta => ({ ...SpriteMeta.default(), id, name: id })
const sprites = (...ids: string[]): Sprites => ({
  datas: ids.map(spriteData),
  metas: ids.map(spriteMeta),
})

describe('spriteDatasWithId and spriteMetasWithId', () => {
  it('default to an empty sprite for an unknown id', () => {
    const store = createStore()

    expect(store.get(spriteDatasWithId('unknown'))).toEqual(SpriteData.default())
    expect(store.get(spriteMetasWithId('unknown'))).toEqual(SpriteMeta.default())
  })

  it('return the same atom for the same id', () => {
    expect(spriteDatasWithId('a')).toBe(spriteDatasWithId('a'))
    expect(spriteMetasWithId('a')).toBe(spriteMetasWithId('a'))
  })
})

describe('allSpritesState', () => {
  it('is empty by default', () => {
    const store = createStore()

    expect(store.get(allSpritesState)).toEqual({ datas: [], metas: [] })
  })

  it('stores every sprite under its id and keeps their order', () => {
    const store = createStore()

    store.set(allSpritesState, sprites('a', 'b'))

    expect(store.get(spriteIdsState)).toEqual(['a', 'b'])
    expect(store.get(spriteDatasWithId('b'))).toEqual(spriteData('b'))
    expect(store.get(spriteMetasWithId('b'))).toEqual(spriteMeta('b'))
    expect(store.get(allSpritesState)).toEqual(sprites('a', 'b'))
  })

  it('accepts an updater derived from the current sprites', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))

    store.set(allSpritesState, (current) => ({
      datas: [...current.datas, spriteData('b')],
      metas: [...current.metas, spriteMeta('b')],
    }))

    expect(store.get(allSpritesState)).toEqual(sprites('a', 'b'))
  })

  it('replaces the previous sprites', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b'))

    store.set(allSpritesState, sprites('c'))

    expect(store.get(allSpritesState)).toEqual(sprites('c'))
  })
})

describe('selectedSpritesState', () => {
  it('holds only the selected sprites, in selection order', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b', 'c'))

    store.set(selectedSpriteIdsState, ['c', 'a'])

    expect(store.get(selectedSpritesState)).toEqual(sprites('c', 'a'))
  })
})

describe('addSpriteAction', () => {
  it('appends a sprite with its data and meta', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))

    store.set(addSpriteAction, 'b', spriteData('b'), spriteMeta('b'))

    expect(store.get(allSpritesState)).toEqual(sprites('a', 'b'))
  })
})

describe('deleteSpritesAction', () => {
  it('removes only the given sprites', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b', 'c'))

    store.set(deleteSpritesAction, ['a', 'c'])

    expect(store.get(allSpritesState)).toEqual(sprites('b'))
  })

  it('leaves the sprites unchanged for unknown ids', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))

    store.set(deleteSpritesAction, ['unknown'])

    expect(store.get(allSpritesState)).toEqual(sprites('a'))
  })
})

describe('applySpriteTransformsAction', () => {
  const positionedSprite = (id: string, locked = false): SpriteData => ({
    ...spriteData(id),
    position: { x: 10, y: 20, z: 5 },
    scale: { x: '1.0', y: '1.0', z: '1.0' },
    rotation: 0,
    locked,
  })

  it('writes position, scale and rotation back to every transformed sprite', () => {
    const store = createStore()
    store.set(spriteDatasWithId('a'), positionedSprite('a'))
    store.set(spriteDatasWithId('b'), positionedSprite('b'))
    store.set(selectedSpriteIdsState, ['a', 'b'])

    store.set(applySpriteTransformsAction, [
      {
        id: 'a',
        position: { x: 100, y: 200 },
        scale: { x: '2.00', y: '0.50' },
        rotation: 90,
      },
      {
        id: 'b',
        position: { x: -40, y: 60 },
        scale: { x: '1.25', y: '3.00' },
        rotation: 270,
      },
    ])

    expect(store.get(spriteDatasWithId('a'))).toMatchObject({
      position: { x: 100, y: 200, z: 5 },
      scale: { x: '2.00', y: '0.50', z: '1.0' },
      rotation: 90,
    })
    expect(store.get(spriteDatasWithId('b'))).toMatchObject({
      position: { x: -40, y: 60, z: 5 },
      scale: { x: '1.25', y: '3.00', z: '1.0' },
      rotation: 270,
    })
  })

  it('preserves the non-transformed properties of each sprite', () => {
    const store = createStore()
    const original = {
      ...positionedSprite('a'),
      opacity: 0.4,
      isStatic: true,
      weight: 4242,
      relativePath: 'assets/a.png',
    }
    store.set(spriteDatasWithId('a'), original)

    store.set(applySpriteTransformsAction, [
      { id: 'a', position: { x: 1, y: 2 }, scale: { x: '2.00', y: '2.00' }, rotation: 180 },
    ])

    expect(store.get(spriteDatasWithId('a'))).toEqual({
      ...original,
      position: { x: 1, y: 2, z: 5 },
      scale: { x: '2.00', y: '2.00', z: '1.0' },
      rotation: 180,
    })
  })

  it('keeps the multi-selection active after the transform ends', () => {
    const store = createStore()
    store.set(spriteDatasWithId('a'), positionedSprite('a'))
    store.set(spriteDatasWithId('b'), positionedSprite('b'))
    store.set(selectedSpriteIdsState, ['a', 'b'])

    store.set(applySpriteTransformsAction, [
      { id: 'a', position: { x: 1, y: 1 }, scale: { x: '1.00', y: '1.00' }, rotation: 0 },
      { id: 'b', position: { x: 2, y: 2 }, scale: { x: '1.00', y: '1.00' }, rotation: 0 },
    ])

    expect(store.get(selectedSpriteIdsState)).toEqual(['a', 'b'])
  })

  it('leaves locked sprites untouched when they are excluded from the writeback', () => {
    const store = createStore()
    const lockedSprite = positionedSprite('locked', true)
    store.set(spriteDatasWithId('locked'), lockedSprite)
    store.set(spriteDatasWithId('free'), positionedSprite('free'))
    store.set(selectedSpriteIdsState, ['locked', 'free'])

    store.set(applySpriteTransformsAction, [
      {
        id: 'free',
        position: { x: 300, y: 400 },
        scale: { x: '1.50', y: '1.50' },
        rotation: 45,
      },
    ])

    // The locked sprite keeps its original geometry, including z-order.
    expect(store.get(spriteDatasWithId('locked'))).toEqual(lockedSprite)
    // The editable sprite still receives the shared transform.
    expect(store.get(spriteDatasWithId('free'))).toMatchObject({
      position: { x: 300, y: 400, z: 5 },
      rotation: 45,
    })
    // Selection is preserved, including the locked member.
    expect(store.get(selectedSpriteIdsState)).toEqual(['locked', 'free'])
  })

  it('applies the single-selection transform exactly like the old per-sprite flow', () => {
    const store = createStore()
    store.set(spriteDatasWithId('a'), positionedSprite('a'))
    store.set(selectedSpriteIdsState, ['a'])

    store.set(applySpriteTransformsAction, [
      {
        id: 'a',
        position: { x: 12, y: 34 },
        scale: { x: '0.75', y: '0.75' },
        rotation: 15,
      },
    ])

    expect(store.get(selectedSpriteIdsState)).toEqual(['a'])
    expect(store.get(spriteDatasWithId('a'))).toMatchObject({
      position: { x: 12, y: 34, z: 5 },
      scale: { x: '0.75', y: '0.75', z: '1.0' },
      rotation: 15,
    })
  })
})

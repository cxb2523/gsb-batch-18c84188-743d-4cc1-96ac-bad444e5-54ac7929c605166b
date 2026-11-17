import { describe, expect, it } from 'vitest'

import { SpriteData } from '../../../model/SpriteData'
import { normaliseRotation, readNodeTransform, resolveTransformerNodes } from './transform'

const fakeNode = (
  overrides: Partial<{
    id: string
    x: number
    y: number
    scaleX: number
    scaleY: number
    rotation: number
  }>,
) => {
  const attrs = { id: 'sprite', x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, ...overrides }
  return {
    id: () => attrs.id,
    x: () => attrs.x,
    y: () => attrs.y,
    scaleX: () => attrs.scaleX,
    scaleY: () => attrs.scaleY,
    rotation: () => attrs.rotation,
  }
}

const data = (id: string, locked = false): SpriteData => ({ ...SpriteData.default(), id, locked })

const registryOf = (ids: string[]) =>
  new Map(ids.map((id) => [id, { id: () => id }])) as unknown as Map<string, any>

describe('normaliseRotation', () => {
  it('rounds and keeps angles inside the 0..359 range', () => {
    expect(normaliseRotation(0)).toBe(0)
    expect(normaliseRotation(42.4)).toBe(42)
    expect(normaliseRotation(359.6)).toBe(0)
  })

  it('wraps negative angles back into positive degrees', () => {
    expect(normaliseRotation(-90)).toBe(270)
    expect(normaliseRotation(-1)).toBe(359)
    expect(normaliseRotation(-720)).toBe(0)
  })

  it('wraps angles above 360 degrees', () => {
    expect(normaliseRotation(450)).toBe(90)
    expect(normaliseRotation(720)).toBe(0)
  })
})

describe('readNodeTransform', () => {
  it('reads position, scale and rotation in the persisted shape', () => {
    const node = fakeNode({
      id: 'a',
      x: 120.4,
      y: -80.6,
      scaleX: 2.345,
      scaleY: 0.5,
      rotation: 90,
    })

    expect(readNodeTransform(node)).toEqual({
      id: 'a',
      position: { x: 120, y: -81 },
      scale: { x: '2.35', y: '0.50' },
      rotation: 90,
    })
  })

  it('normalises negative rotation produced by rotating counter-clockwise', () => {
    const node = fakeNode({ id: 'a', rotation: -45 })

    expect(readNodeTransform(node).rotation).toBe(315)
  })
})

describe('resolveTransformerNodes', () => {
  it('returns every selected node in selection order', () => {
    const registry = registryOf(['a', 'b', 'c'])

    const nodes = resolveTransformerNodes(
      ['c', 'a', 'b'],
      [data('a'), data('b'), data('c')],
      registry,
    )

    expect(nodes.map((node) => node.id())).toEqual(['c', 'a', 'b'])
  })

  it('excludes locked sprites so their geometry cannot be transformed', () => {
    const registry = registryOf(['a', 'locked', 'b'])

    const nodes = resolveTransformerNodes(
      ['a', 'locked', 'b'],
      [data('a'), data('locked', true), data('b')],
      registry,
    )

    expect(nodes.map((node) => node.id())).toEqual(['a', 'b'])
  })

  it('returns an empty list when every selected sprite is locked', () => {
    const registry = registryOf(['locked'])

    expect(resolveTransformerNodes(['locked'], [data('locked', true)], registry)).toEqual([])
  })

  it('skips ids that have no rendered node yet', () => {
    const registry = registryOf(['a'])

    const nodes = resolveTransformerNodes(['a', 'missing'], [data('a'), data('missing')], registry)

    expect(nodes.map((node) => node.id())).toEqual(['a'])
  })
})

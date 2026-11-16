import { afterEach, describe, expect, it, vi } from 'vitest'
import { Compositor } from './compositor'

class TestOffscreenCanvas {
  width: number
  height: number
  readonly ctx = {
    clearRect: vi.fn(),
    setTransform: vi.fn(),
  }

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(): CanvasRenderingContext2D {
    return this.ctx as unknown as CanvasRenderingContext2D
  }
}

function screenContext(): CanvasRenderingContext2D {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
  } as unknown as CanvasRenderingContext2D
}

function createCompositor(dpr = 1, width = 100, height = 100) {
  vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
  const canvas = document.createElement('canvas')
  const screen = screenContext()
  ;(canvas as any).getContext = vi.fn(() => screen)
  const compositor = new Compositor(canvas)
  compositor.resize(width, height, dpr)
  return { compositor, screen, canvas }
}

/** Layer names in the order they were drawn to the screen by the most recent composite(). */
function drawnLayers(screen: CanvasRenderingContext2D, compositor: Compositor): string[] {
  const layers = (compositor as unknown as { layers: Map<string, unknown> }).layers
  return vi.mocked(screen.drawImage).mock.calls.map(call => {
    for (const [name, canvas] of layers) {
      if (canvas === call[0]) return name
    }
    return 'unknown'
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Partial repaint boundaries', () => {
  it.each([1, 1.25, 1.5, 2, 3])('keeps damage alignment idempotent at DPR %s', dpr => {
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
    const canvas = document.createElement('canvas')
    ;(canvas as any).getContext = vi.fn(() => screenContext())
    const compositor = new Compositor(canvas)
    compositor.resize(100, 100, dpr)
    const aligned = compositor.getPaintRect({ x: 0.3, y: 2.1, width: 8.2, height: 6.3 })
    expect(aligned.x).toBeLessThanOrEqual(0.3)
    expect(aligned.y).toBeLessThanOrEqual(2.1)
    expect(aligned.x + aligned.width).toBeGreaterThanOrEqual(8.5)
    expect(aligned.y + aligned.height).toBeGreaterThanOrEqual(8.4 - 1e-10)
    expect(compositor.getPaintRect(aligned)).toEqual(aligned)
    compositor.clearLayer('main', aligned)
    expect(compositor.getContext('main').ctx.clearRect).toHaveBeenLastCalledWith(aligned.x, aligned.y, aligned.width, aligned.height)
  })

  it('clamps offscreen damage and skips empty rectangles', () => {
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
    const canvas = document.createElement('canvas')
    ;(canvas as any).getContext = vi.fn(() => screenContext())
    const compositor = new Compositor(canvas)
    compositor.resize(100, 80, 2)
    expect(compositor.getPaintRect({ x: -20, y: -10, width: 200, height: 100 }))
      .toEqual({ x: 0, y: 0, width: 100, height: 80 })
    expect(compositor.getPaintRect({ x: 0.2, y: 0.2, width: 0, height: 10 }).width).toBe(0)
  })


  it('clears the complete backing store and normalizes invalid damage', () => {
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
    const canvas = document.createElement('canvas')
    ;(canvas as any).getContext = vi.fn(() => screenContext())
    const compositor = new Compositor(canvas)
    compositor.resize(101, 81, 1.25)
    const full = compositor.getPaintRect()
    expect(full.width * 1.25).toBe(canvas.width)
    expect(full.height * 1.25).toBe(canvas.height)
    expect(compositor.getPaintRect({ x: NaN, y: 0, width: 10, height: 10 })).toEqual(full)
    compositor.clearLayer('main')
    expect(compositor.getContext('main').ctx.clearRect).toHaveBeenLastCalledWith(0, 0, full.width, full.height)
    compositor.composite()
    compositor.markDirtyRect('main', { x: -100, y: -100, width: 10, height: 10 })
    expect(compositor.isDirty('main')).toBe(false)
  })
})


describe('Layer order changes', () => {
  it('repaints a partial dirty region in the new order and lets the promoted layer cover the lower one', () => {
    const { compositor, screen } = createCompositor(1, 100, 80)
    // Paint both layers once; afterwards nothing is dirty.
    compositor.markDirtyRect('main', { x: 10, y: 10, width: 40, height: 30 })
    compositor.composite()
    compositor.markDirtyRect('overlay', { x: 20, y: 20, width: 40, height: 30 })
    compositor.composite()
    vi.mocked(screen.drawImage).mockClear()
    vi.mocked(screen.clearRect).mockClear()
    vi.mocked(screen.clip).mockClear()
    vi.mocked(screen.rect).mockClear()

    compositor.bringLayerToFront('main')
    expect(compositor.getLayerOrder()).toEqual(['background', 'transient', 'overlay', 'tooltip', 'main'])

    // Only a local dirty rect is marked after the order change.
    compositor.markDirtyRect('transient', { x: 22, y: 24, width: 8, height: 6 })
    compositor.composite()

    // The order change restricts the composite to where stacking actually changed; it must not
    // fall back to clearing the whole screen. `main` (10,10 40x30) now overlaps both `overlay`
    // (20,20 40x30) and `transient` (dirty at 22,24 8x6); only the `main`/`overlay` overlap
    // changes visible pixels, and the incoming local damage is contained in it.
    const cleared = vi.mocked(screen.clearRect).mock.calls
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toEqual([20, 20, 30, 20])
    expect(vi.mocked(screen.clip).mock.calls).toHaveLength(1)
    expect(vi.mocked(screen.rect).mock.calls.at(-1)).toEqual([20, 20, 30, 20])

    // Every layer is drawn again, in exactly the new stacking order.
    const drawn = drawnLayers(screen, compositor)
    expect(drawn).toEqual(compositor.getLayerOrder())
    expect(drawn.indexOf('main')).toBeGreaterThan(drawn.indexOf('overlay'))
    expect(drawn.indexOf('main')).toBeGreaterThan(drawn.indexOf('transient'))
    expect(drawn.indexOf('main')).toBe(drawn.length - 1)
  })

  it('recomposites the overlapping region when only the order changes', () => {
    const { compositor, screen } = createCompositor(1, 200, 200)
    compositor.markDirtyRect('main', { x: 10, y: 10, width: 50, height: 40 })
    compositor.markDirtyRect('overlay', { x: 30, y: 20, width: 50, height: 40 })
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()
    vi.mocked(screen.drawImage).mockClear()

    compositor.sendLayerToBack('overlay')
    compositor.composite()

    expect(vi.mocked(screen.clearRect).mock.calls).toEqual([[30, 20, 30, 30]])
    expect(drawnLayers(screen, compositor)).toEqual(compositor.getLayerOrder())
    expect(compositor.getLayerOrder()[0]).toBe('overlay')
  })

  it('adds order-change damage to later local damage', () => {
    const { compositor, screen } = createCompositor(1, 200, 200)
    compositor.markDirtyRect('main', { x: 10, y: 10, width: 40, height: 40 })
    compositor.markDirtyRect('overlay', { x: 20, y: 20, width: 40, height: 40 })
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()

    compositor.sendLayerToBack('overlay')
    compositor.markDirtyRect('tooltip', { x: 100, y: 100, width: 10, height: 10 })
    compositor.composite()

    // Union of the order-change overlap and the new local damage.
    expect(vi.mocked(screen.clearRect).mock.calls).toEqual([[20, 20, 90, 90]])
  })

  it('does not request a repaint when the order is set to its current value', () => {
    const { compositor, screen } = createCompositor(1, 100, 80)
    compositor.markDirtyRect('main', { x: 5, y: 5, width: 10, height: 10 })
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()

    compositor.setLayerOrder(compositor.getLayerOrder())
    compositor.moveLayer('main', 1)
    compositor.composite()

    expect(screen.clearRect).not.toHaveBeenCalled()
  })

  it('ignores unknown and duplicate names when replacing the whole order', () => {
    const { compositor } = createCompositor(1, 100, 80)
    compositor.setLayerOrder(['tooltip', 'missing', 'tooltip', 'main'])
    expect(compositor.getLayerOrder()).toEqual(['tooltip', 'main', 'background', 'transient', 'overlay'])
  })

  it('reorders through registerLayer(index) and moveLayer', () => {
    const { compositor, screen } = createCompositor(1, 100, 80)
    compositor.registerLayer('custom', 0)
    expect(compositor.getLayerOrder()[0]).toBe('custom')
    compositor.registerLayer('custom', 2)
    expect(compositor.getLayerOrder()[2]).toBe('custom')
    compositor.registerLayer('custom')
    // Re-registering without an index never changes the order.
    expect(compositor.getLayerOrder()[2]).toBe('custom')

    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()
    compositor.markDirtyRect('main', { x: 10, y: 10, width: 30, height: 30 })
    compositor.markDirtyRect('custom', { x: 20, y: 20, width: 30, height: 30 })
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()

    compositor.moveLayer('custom', 0)
    compositor.composite()
    expect(vi.mocked(screen.clearRect).mock.calls).toEqual([[20, 20, 20, 20]])
  })

  it('recomposites only the removed region when a layer is unregistered', () => {
    const { compositor, screen } = createCompositor(1, 100, 80)
    compositor.clearLayer('overlay', { x: 30, y: 30, width: 20, height: 20 })
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()

    compositor.unregisterLayer('overlay')
    compositor.composite()

    expect(vi.mocked(screen.clearRect).mock.calls).toEqual([[30, 30, 20, 20]])
    expect(compositor.getLayerOrder()).not.toContain('overlay')
  })

  it('does not repaint for a reorder of layers that were never painted', () => {
    const { compositor, screen } = createCompositor(1, 100, 80)
    compositor.registerLayer('empty-layer')
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()

    compositor.moveLayer('empty-layer', 0)
    compositor.composite()

    expect(screen.clearRect).not.toHaveBeenCalled()
  })

  it('keeps a partial repaint when a reordered layer was painted in full', () => {
    const { compositor, screen } = createCompositor(1, 100, 80)
    // `main` is painted in full once; `overlay` only ever holds a small region.
    compositor.clearLayer('main')
    compositor.composite()
    compositor.clearLayer('overlay', { x: 20, y: 20, width: 15, height: 10 })
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()

    compositor.sendLayerToBack('overlay')
    compositor.composite()

    // One full-canvas layer only contributes the other layer's known extent; no full-screen fallback.
    expect(vi.mocked(screen.clearRect).mock.calls).toEqual([[20, 20, 15, 10]])
  })

  it('falls back to a full composite when two reordered layers both cover the canvas', () => {
    const { compositor, screen } = createCompositor(1, 100, 80)
    compositor.clearLayer('main')
    compositor.clearLayer('overlay')
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()

    compositor.bringLayerToFront('main')
    compositor.composite()

    expect(vi.mocked(screen.clearRect).mock.calls).toEqual([[0, 0, 100, 80]])
  })
})


describe('Fractional DPR alignment', () => {
  it.each([1, 1.25, 1.5, 2])('keeps aligned damage stable and matches clear/composite boundaries at DPR %s', dpr => {
    const { compositor, screen } = createCompositor(dpr, 101, 81)
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()
    vi.mocked(screen.rect).mockClear()

    const samples = [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0.3, y: 2.1, width: 8.2, height: 6.3 },
      { x: 7.7, y: 5.5, width: 13.1, height: 9.9 },
      { x: 100.4, y: 80.2, width: 3.3, height: 2.7 },
    ]
    for (const sample of samples) {
      const aligned = compositor.getPaintRect(sample)
      expect(aligned.width).toBeGreaterThan(0)
      expect(aligned.height).toBeGreaterThan(0)
      // Alignment is idempotent: feeding the aligned rect back changes nothing.
      expect(compositor.getPaintRect(aligned)).toEqual(aligned)

      compositor.markDirtyRect('main', sample)
      compositor.composite()

      const cleared = vi.mocked(screen.clearRect).mock.calls.at(-1)!
      const clipped = vi.mocked(screen.rect).mock.calls.at(-1)!
      // clearLayer()/composite() clip and clear must share one physical boundary.
      expect(cleared).toEqual(clipped)
      // The screen is cleared in device pixels; the aligned logical rect maps onto exactly them.
      expect(cleared[0]).toBeCloseTo(aligned.x * dpr, 10)
      expect(cleared[1]).toBeCloseTo(aligned.y * dpr, 10)
      expect(cleared[2]).toBeCloseTo(aligned.width * dpr, 10)
      expect(cleared[3]).toBeCloseTo(aligned.height * dpr, 10)
      expect(Number.isInteger(cleared[0])).toBe(true)
      expect(Number.isInteger(cleared[1])).toBe(true)
      expect(Number.isInteger(cleared[2])).toBe(true)
      expect(Number.isInteger(cleared[3])).toBe(true)
    }
  })

  it.each([1, 1.25, 1.5, 2])('maps the aligned clear boundary to the same physical pixels composite clips at DPR %s', dpr => {
    const { compositor, screen } = createCompositor(dpr, 100, 80)
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()

    const sample = { x: 0.3, y: 2.1, width: 8.2, height: 6.3 }
    const aligned = compositor.getPaintRect(sample)
    compositor.clearLayer('main', sample)
    const layerCtx = compositor.getContext('main').ctx
    expect(layerCtx.clearRect).toHaveBeenLastCalledWith(aligned.x, aligned.y, aligned.width, aligned.height)

    compositor.markDirtyRect('main', sample)
    compositor.composite()
    const screenClear = vi.mocked(screen.clearRect).mock.calls.at(-1)!
    const screenClip = vi.mocked(screen.rect).mock.calls.at(-1)!
    expect(screenClear).toEqual(screenClip)
    // The layer's DPR transform turns the aligned logical rect into exactly the device-pixel
    // extent the screen composite clears, with no seam or double-painted edge.
    expect(aligned.x * dpr).toBeCloseTo(screenClear[0]!, 10)
    expect(aligned.y * dpr).toBeCloseTo(screenClear[1]!, 10)
    expect((aligned.x + aligned.width) * dpr).toBeCloseTo(screenClear[0]! + screenClear[2]!, 10)
    expect((aligned.y + aligned.height) * dpr).toBeCloseTo(screenClear[1]! + screenClear[3]!, 10)
  })

  it.each([1, 1.25, 1.5, 2])('normalizes a rectangle clipped away by the canvas edge to canonical empty at DPR %s', dpr => {
    const { compositor, canvas } = createCompositor(dpr, 100, 80)
    const logicalWidth = canvas.width / dpr
    const logicalHeight = canvas.height / dpr

    const atRightEdge = compositor.getPaintRect({ x: logicalWidth, y: 4, width: 10, height: 10 })
    expect(atRightEdge).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(compositor.getPaintRect(atRightEdge)).toEqual(atRightEdge)

    const atBottomEdge = compositor.getPaintRect({ x: 4, y: logicalHeight, width: 10, height: 10 })
    expect(atBottomEdge).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(compositor.getPaintRect(atBottomEdge)).toEqual(atBottomEdge)

    const straddling = compositor.getPaintRect({ x: logicalWidth - 2, y: logicalHeight - 2, width: 10, height: 10 })
    expect(compositor.getPaintRect(straddling)).toEqual(straddling)
    expect(straddling.x).toBeLessThan(logicalWidth)
    expect(straddling.x + straddling.width).toBeCloseTo(logicalWidth, 10)
    expect(straddling.y + straddling.height).toBeCloseTo(logicalHeight, 10)
    expect(straddling.width * dpr).toBeCloseTo(canvas.width - Math.floor((logicalWidth - 2) * dpr), 10)
  })

  it('skips empty and non-finite damage without a full-screen repaint', () => {
    const { compositor, screen } = createCompositor(1.5, 100, 80)
    compositor.composite()
    vi.mocked(screen.clearRect).mockClear()

    compositor.markDirtyRect('main', { x: 3, y: 3, width: 0, height: 10 })
    compositor.markDirtyRect('main', { x: 3, y: 3, width: -4, height: 10 })
    compositor.markDirtyRect('main', { x: 3, y: 3, width: 10, height: 0 })
    compositor.composite()
    expect(screen.clearRect).not.toHaveBeenCalled()
    expect(compositor.isDirty('main')).toBe(false)

    // Non-finite damage keeps the existing rule: it normalizes to the whole layer.
    compositor.markDirtyRect('main', { x: NaN, y: 0, width: 10, height: 10 })
    compositor.composite()
    expect(vi.mocked(screen.clearRect).mock.calls).toEqual([[0, 0, 150, 120]])
  })

  it.each([1, 1.25, 1.5, 2])('keeps alignment idempotent for arbitrary damage at DPR %s', dpr => {
    const { compositor, canvas } = createCompositor(dpr, 137, 91)
    const logicalWidth = canvas.width / dpr
    const logicalHeight = canvas.height / dpr
    const fractions = [0, 0.1, 0.25, 1 / 3, 0.5, 0.7, 0.99]
    for (const fx of fractions) {
      for (const fy of fractions) {
        for (const fw of [0.01, 1, 3.3, 20.7]) {
          for (const fh of [0.01, 1, 5.5, 17.2]) {
            const aligned = compositor.getPaintRect({
              x: Math.max(0, logicalWidth * fx - 3),
              y: Math.max(0, logicalHeight * fy - 3),
              width: fw,
              height: fh,
            })
            expect(compositor.getPaintRect(aligned)).toEqual(aligned)
            // The aligned rect is always a whole number of physical pixels.
            for (const value of [aligned.x, aligned.y, aligned.width, aligned.height]) {
              const physical = value * dpr
              expect(Math.abs(physical - Math.round(physical))).toBeLessThan(1e-9)
            }
            expect(aligned.width).toBeGreaterThanOrEqual(0)
            expect(aligned.height).toBeGreaterThanOrEqual(0)
            expect(aligned.x).toBeGreaterThanOrEqual(0)
            expect(aligned.y).toBeGreaterThanOrEqual(0)
            expect(aligned.x + aligned.width).toBeLessThanOrEqual(logicalWidth + 1e-9)
            expect(aligned.y + aligned.height).toBeLessThanOrEqual(logicalHeight + 1e-9)
          }
        }
      }
    }
  })
})

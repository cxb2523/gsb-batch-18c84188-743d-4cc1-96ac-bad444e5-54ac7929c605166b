// Compositor: 多层 Canvas 合成 + 脏矩形局部重绘

import { PaintContext } from './paint_context'

export type LayerName = string

export const DEFAULT_LAYER_ORDER: LayerName[] = ['background', 'main', 'transient', 'overlay', 'tooltip']

export interface DirtyRect {
  x: number
  y: number
  width: number
  height: number
}

type LayerCanvas = OffscreenCanvas | HTMLCanvasElement

const EMPTY_RECT: DirtyRect = { x: 0, y: 0, width: 0, height: 0 }

function unionRect(a: DirtyRect, b: DirtyRect): DirtyRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x, y, width: right - x, height: bottom - y }
}

function intersectRect(a: DirtyRect, b: DirtyRect): DirtyRect | undefined {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return undefined
  return { x, y, width: right - x, height: bottom - y }
}

export class Compositor {
  private layers = new Map<LayerName, LayerCanvas>()
  private layerOrder: LayerName[] = []
  // 每层的脏矩形（物理像素；null 表示全层脏）
  private dirtyRects = new Map<LayerName, DirtyRect | null>()
  // 每层已知的绘制覆盖范围（物理像素；null 表示覆盖整个画布，undefined 表示尚未绘制）。
  // 图层顺序变化时据此判断必须重新合成的区域，而不是默认全屏重绘。
  private paintedExtents = new Map<LayerName, DirtyRect | null>()
  // 仅由图层顺序变化产生的待合成区域（物理像素；null 表示全屏）
  private orderDamage: DirtyRect | null | undefined
  private width: number
  private height: number
  private dpr: number
  private physicalWidth: number
  private physicalHeight: number
  readonly screenCanvas: HTMLCanvasElement
  private screenCtx: CanvasRenderingContext2D

  constructor(canvas: HTMLCanvasElement, dpr = 1) {
    this.screenCanvas = canvas
    this.screenCtx = canvas.getContext('2d')!
    this.dpr = dpr
    this.width = canvas.width / dpr
    this.height = canvas.height / dpr
    this.physicalWidth = canvas.width
    this.physicalHeight = canvas.height

    for (const name of DEFAULT_LAYER_ORDER) this.registerLayer(name)
  }

  resize(width: number, height: number, dpr = this.dpr): void {
    this.width = width
    this.height = height
    this.dpr = dpr
    this.physicalWidth = Math.max(1, Math.round(width * dpr))
    this.physicalHeight = Math.max(1, Math.round(height * dpr))
    this.screenCanvas.width = this.physicalWidth
    this.screenCanvas.height = this.physicalHeight
    this.paintedExtents.clear()
    this.orderDamage = undefined
    for (const name of this.layerOrder) {
      const off = this._createLayerCanvas()
      this.layers.set(name, off)
      this.dirtyRects.set(name, null)
    }
  }

  registerLayer(name: LayerName, index?: number): void {
    if (this.layers.has(name)) {
      // Re-registering an existing layer with an explicit index is a runtime reorder.
      if (index !== undefined) this.moveLayer(name, index)
      return
    }
    const off = this._createLayerCanvas()
    this.layers.set(name, off)
    if (index === undefined || index < 0 || index >= this.layerOrder.length) {
      this.layerOrder.push(name)
    } else {
      this.layerOrder.splice(index, 0, name)
    }
    this.dirtyRects.set(name, null)
  }

  unregisterLayer(name: LayerName): void {
    const extent = this.paintedExtents.get(name)
    this.layers.delete(name)
    this.dirtyRects.delete(name)
    this.paintedExtents.delete(name)
    this.layerOrder = this.layerOrder.filter(layer => layer !== name)
    // The removed layer's pixels stay on screen until the region is recomposited from the
    // remaining layers.
    if (extent === null) {
      this.orderDamage = null
    } else if (extent) {
      this.orderDamage = this.orderDamage === null
        ? null
        : this.orderDamage === undefined ? extent : unionRect(this.orderDamage, extent)
    }
  }

  getLayerOrder(): LayerName[] {
    return [...this.layerOrder]
  }

  /**
   * Replace the layer stacking order (bottom first). Unknown or duplicate names are ignored;
   * registered layers that are omitted keep their relative order after the listed ones.
   */
  setLayerOrder(order: LayerName[]): void {
    const next: LayerName[] = []
    const included = new Set<LayerName>()
    for (const name of order) {
      if (!this.layers.has(name) || included.has(name)) continue
      included.add(name)
      next.push(name)
    }
    for (const name of this.layerOrder) {
      if (included.has(name)) continue
      included.add(name)
      next.push(name)
    }
    this._commitLayerOrder(next)
  }

  /** Move an existing layer so it ends up at `index` in the stacking order. */
  moveLayer(name: LayerName, index: number): void {
    if (!this.layers.has(name)) return
    const next = this.layerOrder.filter(layer => layer !== name)
    const target = Number.isFinite(index) ? Math.max(0, Math.min(next.length, Math.trunc(index))) : next.length
    next.splice(target, 0, name)
    this._commitLayerOrder(next)
  }

  /** Raise `name` above every other layer. */
  bringLayerToFront(name: LayerName): void {
    this.moveLayer(name, this.layerOrder.length - 1)
  }

  /** Lower `name` below every other layer. */
  sendLayerToBack(name: LayerName): void {
    this.moveLayer(name, 0)
  }

  getContext(layer: LayerName): PaintContext {
    if (!this.layers.has(layer)) this.registerLayer(layer)
    const off = this.layers.get(layer)!
    return new PaintContext(this._getLayerContext(off))
  }

  // 标记整层脏
  markDirty(layer: LayerName): void {
    // An invalidation means "this layer needs repainting"; it says nothing yet about how much of
    // the canvas the layer actually covers. Coverage is recorded when the layer is cleared and
    // painted (clearLayer / markDirtyRect), so a later reorder never over-repaints by default.
    this.dirtyRects.set(layer, null)
  }

  // 标记局部脏矩形
  markDirtyRect(layer: LayerName, rect: DirtyRect): void {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
      // Non-finite damage is normalized to the whole layer, matching getPaintRect()'s rule.
      this.markDirty(layer)
      return
    }
    if (rect.width <= 0 || rect.height <= 0) return
    const physical = this._resolvePhysicalRect(rect)
    if (physical.width <= 0 || physical.height <= 0) return

    // Track where this layer is known to have content. Painters that skip clearing
    // (`clear: false`) never call clearLayer(), so the damage report is their only coverage
    // signal; over-approximating it can only make a later reorder repaint slightly more.
    this._addPaintedExtent(layer, physical)

    const existing = this.dirtyRects.get(layer)
    if (existing === null) return  // 已经是全层脏，不需要合并
    if (existing === undefined) {
      this.dirtyRects.set(layer, physical)
    } else {
      this.dirtyRects.set(layer, unionRect(existing, physical))
    }
  }

  /**
   * Resolve the logical rectangle to the canonical physical-pixel boundary used by clearing,
   * painting and compositing. The result is a fixed point: passing an aligned rectangle back in
   * returns the identical rectangle at every DPR, and an empty/clipped-away rectangle is always
   * the canonical `{ x: 0, y: 0, width: 0, height: 0 }`.
   */
  getPaintRect(rect?: DirtyRect): DirtyRect {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
      return { x: 0, y: 0, width: this.physicalWidth / this.dpr, height: this.physicalHeight / this.dpr }
    }
    if (rect.width <= 0 || rect.height <= 0) return { ...EMPTY_RECT }
    const physical = this._resolvePhysicalRect(rect)
    return this._logicalRect(physical)
  }

  // 清除指定层（全层或脏矩形区域）
  clearLayer(layer: LayerName, rect?: DirtyRect): void {
    if (!this.layers.has(layer)) this.registerLayer(layer)
    const off = this.layers.get(layer)!
    const ctx = this._getLayerContext(off)
    if (rect) {
      // The layer context carries the DPR transform, and the aligned logical rect maps back
      // onto exactly the device pixels that composite() clears/clips.
      const aligned = this.getPaintRect(rect)
      if (aligned.width <= 0 || aligned.height <= 0) return
      ctx.clearRect(aligned.x, aligned.y, aligned.width, aligned.height)
      // Pixels outside a partial clear survive, so coverage only grows here. Over-approximating
      // is safe: a later layer order change may repaint a little more, never less.
      this._addPaintedExtent(layer, this._resolvePhysicalRect(aligned))
    } else {
      ctx.clearRect(0, 0, this.physicalWidth / this.dpr, this.physicalHeight / this.dpr)
      // The following repaint is unclipped, so the layer is about to cover the whole canvas.
      this.paintedExtents.set(layer, null)
    }
  }

  isDirty(layer: LayerName): boolean {
    return this.dirtyRects.get(layer) !== undefined
  }

  // 合成到屏幕 Canvas（只重绘脏区域）
  composite(): void {
    const sc = this.screenCtx
    const damage = this._collectDamage()
    if (damage !== undefined) {
      if (damage === null) {
        // 全屏重绘：存在全层脏，或顺序变化影响到了覆盖整屏的图层
        sc.clearRect(0, 0, this.physicalWidth, this.physicalHeight)
        for (const name of this.layerOrder) {
          sc.drawImage(this.layers.get(name)!, 0, 0)
        }
      } else if (damage.width > 0 && damage.height > 0) {
        // 局部重绘：始终按当前图层顺序重新合成该区域，保证被遮挡内容重新覆盖
        const { x, y, width, height } = damage
        sc.clearRect(x, y, width, height)
        sc.save()
        sc.beginPath()
        sc.rect(x, y, width, height)
        sc.clip()
        for (const name of this.layerOrder) {
          sc.drawImage(this.layers.get(name)!, 0, 0)
        }
        sc.restore()
      }
    }

    // 清空脏标记；已绘制覆盖范围保留，供后续图层顺序变化使用
    for (const name of this.layerOrder) {
      this.dirtyRects.delete(name)
    }
    this.orderDamage = undefined
  }

  /**
   * Physical-pixel region that must be recomposited: the union of per-layer damage and any
   * damage produced by a layer order change. `undefined` means nothing to do; `null` means the
   * whole canvas (a layer that covers the whole backing store is dirty or changed stacking).
   */
  private _collectDamage(): DirtyRect | null | undefined {
    let hasDirty = false
    let union: DirtyRect | undefined
    for (const name of this.layerOrder) {
      const dr = this.dirtyRects.get(name)
      if (dr === undefined) continue
      hasDirty = true
      if (dr === null) return null
      union = union ? unionRect(union, dr) : dr
    }
    if (this.orderDamage === null) return null
    if (this.orderDamage) {
      hasDirty = true
      union = union ? unionRect(union, this.orderDamage) : this.orderDamage
    }
    return hasDirty ? union : undefined
  }

  private _commitLayerOrder(next: LayerName[]): void {
    const previous = this.layerOrder
    if (previous.length === next.length && next.every((name, i) => name === previous[i])) return
    this.layerOrder = next

    const region = this._orderChangeRegion(previous, next)
    if (region === null) {
      this.orderDamage = null
      return
    }
    if (!region) return
    this.orderDamage = this.orderDamage === null
      ? null
      : this.orderDamage === undefined ? region : unionRect(this.orderDamage, region)
  }

  /**
   * Region whose visible pixels can change when the stacking order changes.
   *
   * Pixels can only change where two layers whose relative order changed overlap, so the region
   * is the union of those pairwise overlaps (a layer painted over the whole canvas contributes
   * the other layer's known extent). Returns null when the whole canvas is affected and
   * undefined when no overlapping reordered pair has recorded coverage.
   */
  private _orderChangeRegion(previous: LayerName[], next: LayerName[]): DirtyRect | null | undefined {
    const previousIndex = new Map<LayerName, number>()
    const nextIndex = new Map<LayerName, number>()
    previous.forEach((name, index) => previousIndex.set(name, index))
    next.forEach((name, index) => nextIndex.set(name, index))

    const names = new Set([...previous, ...next])
    const changed: LayerName[] = []
    for (const name of names) {
      if (previousIndex.get(name) !== nextIndex.get(name)) changed.push(name)
    }
    if (changed.length < 2) return undefined

    let full = false
    let region: DirtyRect | undefined
    const add = (rect: DirtyRect) => {
      region = region ? unionRect(region, rect) : { ...rect }
    }
    for (let i = 0; i < changed.length; i++) {
      for (let j = i + 1; j < changed.length; j++) {
        const a = changed[i]!
        const b = changed[j]!
        const beforeA = previousIndex.get(a)!
        const beforeB = previousIndex.get(b)!
        const afterA = nextIndex.get(a)!
        const afterB = nextIndex.get(b)!
        if ((beforeA < beforeB) === (afterA < afterB)) continue  // this pair kept its order

        const extentA = this.paintedExtents.get(a)
        const extentB = this.paintedExtents.get(b)
        if (extentA === null && extentB === null) {
          full = true
          break
        }
        if (extentA === null) {
          if (extentB) add(extentB)
        } else if (extentB === null) {
          if (extentA) add(extentA)
        } else if (extentA && extentB) {
          const overlap = intersectRect(extentA, extentB)
          if (overlap) add(overlap)
        }
      }
      if (full) break
    }
    return full ? null : region
  }

  private _createLayerCanvas(): LayerCanvas {
    if (typeof OffscreenCanvas !== 'undefined') {
      return new OffscreenCanvas(this.physicalWidth, this.physicalHeight)
    }
    const canvas = this.screenCanvas.ownerDocument.createElement('canvas')
    canvas.width = this.physicalWidth
    canvas.height = this.physicalHeight
    return canvas
  }

  private _getLayerContext(canvas: LayerCanvas): CanvasRenderingContext2D {
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
    if (typeof ctx.setTransform === 'function') {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    }
    return ctx
  }

  /** Union a physical rect into the layer's recorded painted coverage. */
  private _addPaintedExtent(layer: LayerName, rect: DirtyRect): void {
    const previous = this.paintedExtents.get(layer)
    // A `null` extent means the whole canvas is already covered; it never shrinks.
    if (previous === null) return
    this.paintedExtents.set(layer, previous === undefined ? rect : unionRect(previous, rect))
  }

  private _logicalRect(physical: DirtyRect): DirtyRect {
    return {
      x: physical.x / this.dpr,
      y: physical.y / this.dpr,
      width: physical.width / this.dpr,
      height: physical.height / this.dpr,
    }
  }

  /**
   * Snap a logical rectangle to the inclusive-left / exclusive-right physical pixel boundary.
   * Values that are within floating-point round-off of an integer are treated as that integer,
   * so an already aligned boundary stays on the same pixel row at fractional DPR.
   */
  private _resolvePhysicalRect(rect: DirtyRect): DirtyRect {
    const stable = (value: number) => {
      const rounded = Math.round(value)
      return Math.abs(value - rounded) <= 1e-9 * Math.max(1, Math.abs(value)) ? rounded : value
    }
    const left = Math.max(0, Math.min(this.physicalWidth, Math.floor(stable(rect.x * this.dpr))))
    const top = Math.max(0, Math.min(this.physicalHeight, Math.floor(stable(rect.y * this.dpr))))
    const right = Math.max(left, Math.min(
      this.physicalWidth,
      Math.ceil(stable((rect.x + Math.max(0, rect.width)) * this.dpr)),
    ))
    const bottom = Math.max(top, Math.min(
      this.physicalHeight,
      Math.ceil(stable((rect.y + Math.max(0, rect.height)) * this.dpr)),
    ))
    if (right <= left || bottom <= top) return { ...EMPTY_RECT }
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
}

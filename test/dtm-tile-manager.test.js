import { assert } from '@esm-bundle/chai'
import { DtmTileManager, SatTileCache } from '../src/layers/gis/ImageTerrainImpl.js'
import { tileToMercBbox } from '../src/layers/gis/TileLayer.js'
import { createFakeRegl, installFakeImage, flush } from './helpers/fake-regl.js'

const DTM_SOURCE = { type: 'xyz', url: 'https://dtm.example/{z}/{x}/{y}.png', minZoom: 0, maxZoom: 14 }
const SAT_SOURCE = { type: 'xyz', url: 'https://sat.example/{z}/{x}/{y}.png', minZoom: 0, maxZoom: 19 }
const WMS_SAT_SOURCE = {
  type: 'wms', url: 'https://wms.example/map', layers: 'img',
  version: '1.3.0', minZoom: 0, maxZoom: 19,
}
// 256px viewport: a domain centered in one tile (60% of it) resolves to exactly
// that one tile at its own zoom level, so each sync has a single needed tile.
const VIEWPORT = { width: 256, height: 256 }

function createManager({ dtmCrs = 'EPSG:3857', satCrs = 'EPSG:3857', satSource = SAT_SOURCE, tessellation = 8 } = {}) {
  const regl = createFakeRegl()
  const fns = {
    xTexFns: [() => null],
    zTexFns: [() => null],
    dtmTexFns: [() => null],
    satTexFns: [() => null],
    satUvXTexFns: [() => null],
    satUvYTexFns: [() => null],
    dtmUvRangeFns: [() => null],
  }
  const satCacheRef = { cache: null }
  const manager = new DtmTileManager({
    regl, source: DTM_SOURCE,
    dtmTileCrs: dtmCrs, plotCrs: dtmCrs, satTileCrs: satCrs,
    tessellation,
    ...fns,
    satCacheRef,
    onLoad: () => {},
  })
  satCacheRef.cache = new SatTileCache({ regl, source: satSource, satTileCrs: satCrs, onLoad: () => {} })
  return { regl, manager, cache: satCacheRef.cache, fns }
}

// Viewport domain centered inside one tile, spanning 60% of it. It stays well
// clear of every tile edge so mercToTileXY maps it to exactly that one tile at
// every zoom boundary (an inset-to-edge domain still straddles the neighbour via
// floor() once the computed zoom moves up by one level).
function singleTileDomain(tx, ty, z) {
  const t = tileToMercBbox(tx, ty, z)
  const cx = (t.minX + t.maxX) / 2
  const cy = (t.minY + t.maxY) / 2
  const halfW = (t.maxX - t.minX) * 0.3
  const halfH = (t.maxY - t.minY) * 0.3
  return {
    xDomain: [cx - halfW, cx + halfW],
    yDomain: [cy - halfH, cy + halfH],
  }
}

// Seed a loaded sat tile directly, bypassing image loading / zoom heuristics so
// selection and UV assertions are independent of request zoom math.
function seedSat(cache, regl, z, tx, ty) {
  const key = `${z}/${tx}/${ty}`
  cache.tiles.set(key, {
    status: 'loaded',
    texture: regl.texture({}),
    bounds: tileToMercBbox(tx, ty, z),
  })
  cache.accessOrder.push(key)
  return key
}

async function settle(manager, cache, spins = 30) {
  for (let i = 0; i < spins; i++) {
    const dtmReady = [...manager.tiles.values()].every(t => t.status === 'loaded')
    const satReady = [...cache.tiles.values()].every(t => t.status === 'loaded')
    if (dtmReady && satReady) break
    await flush()
  }
}

function uvArraysAt(fns, index) {
  const uvXTex = fns.satUvXTexFns[index]()
  const uvYTex = fns.satUvYTexFns[index]()
  return { uvX: uvXTex.data, uvY: uvYTex.data }
}

// Find the render item drawn from a given DTM slot and return its fn[] index.
function itemIndexForSlot(manager, slot) {
  const index = manager._renderItems.findIndex(item => item.slot === slot)
  assert.isAtLeast(index, 0, 'no render item references the expected slot')
  return index
}

function assertUvsInUnitRange(uvX, uvY) {
  assert.equal(uvX.length, uvY.length)
  for (let i = 0; i < uvX.length; i++) {
    assert.isAtLeast(uvX[i], 0, `uvX[${i}] below 0`)
    assert.isAtMost(uvX[i], 1, `uvX[${i}] above 1`)
    assert.isAtLeast(uvY[i], 0, `uvY[${i}] below 0`)
    assert.isAtMost(uvY[i], 1, `uvY[${i}] above 1`)
  }
}

describe('DtmTileManager — ancestor fallback sat UV reconstruction', () => {
  let fakeImage

  afterEach(() => {
    fakeImage?.restore()
  })

  it('maps a fallback sub-mesh to a covering ancestor sat tile with all sat UVs inside [0,1]', async () => {
    // Hold every z=10 image: the target DTM tile stays "loading" and no z=10 sat
    // tile can finish, so the manager falls back to the loaded z=9 ancestor.
    fakeImage = installFakeImage({ hold: url => url.includes('/10/') })
    const { regl, manager, cache, fns } = createManager()

    // Phase A: load ancestor z=9 DTM tile 9/256/171, then give the cache a loaded
    // z=9 sat tile whose footprint matches the DTM tile.
    const a = singleTileDomain(256, 171, 9)
    manager.syncTiles(a.xDomain, a.yDomain, VIEWPORT)
    await settle(manager, cache)
    assert.includeMembers([...manager.tiles.keys()], ['9/256/171'])
    const satKey = seedSat(cache, regl, 9, 256, 171)
    manager._rebuildArrays()

    // Phase B: zoom into z=10 child (qx=0, qy=0). Its DTM tile is held loading.
    // Inset domain so the view resolves to the single z=10 target tile.
    const b = singleTileDomain(512, 342, 10)
    manager.syncTiles(b.xDomain, b.yDomain, VIEWPORT)
    assert.equal(manager.tiles.get('10/512/342')?.status, 'loading',
      'target DTM tile is still loading')
    manager.requestSatTiles(VIEWPORT)
    await settle(manager, cache)

    // One render item for the needed z=10 slot, sourced from the z=9 ancestor.
    assert.lengthOf(manager._renderItems, 1)
    const ancestorSlot = manager.tiles.get('9/256/171').slot
    const item = manager._renderItems[0]
    assert.equal(item.slot, ancestorSlot)
    assert.deepEqual(item.range, [0, 0, 0.5, 0.5])

    // Its imagery footprint is the sub-mesh footprint. The (0,0) child shares the
    // ancestor's min edges (which may quantise to exactly 0), so assert the
    // remaining three edges lie strictly inside the ancestor tile.
    const z9 = tileToMercBbox(256, 171, 9)
    assert.isBelow(item.satBbox.maxX, z9.maxX)
    assert.isBelow(item.satBbox.maxY, z9.maxY)
    assert.isAtLeast(item.satBbox.minX, z9.minX)
    assert.isAtLeast(item.satBbox.minY, z9.minY)
    // And the footprint is materially smaller than the ancestor (a true sub-region).
    assert.isBelow(item.satBbox.maxX - item.satBbox.minX, z9.maxX - z9.minX)

    // The covering z=9 sat tile is selected and provably covers the sub-mesh.
    assert.isOk(item.sat)
    assert.equal(item.sat.key, satKey)
    assert.isTrue(cache._tileCoversBbox(item.sat.bounds, item.satBbox))

    // All uploaded sat UVs stay within [0,1]. The UV texture spans the full
    // ancestor slot; the sub-region is clipped in the vertex shader via dtmUvRange.
    const fnIndex = itemIndexForSlot(manager, ancestorSlot)
    const { uvX, uvY } = uvArraysAt(fns, fnIndex)
    assertUvsInUnitRange(uvX, uvY)

    // The sub-mesh's own footprint maps into the top-left quadrant of the sat
    // texture (u<=0.5; the qy=0 northern child maps to flipped v>=0.5), proving
    // UVs were rebuilt from the sub-mesh bbox rather than the full ancestor tile.
    const satBounds = item.sat.bounds
    const bW = satBounds.maxX - satBounds.minX
    const bH = satBounds.maxY - satBounds.minY
    const subU1 = (item.satBbox.maxX - satBounds.minX) / bW
    const subV0 = 1.0 - (item.satBbox.maxY - satBounds.minY) / bH
    assert.isAtMost(subU1, 0.5 + 1e-6, 'sub-mesh footprint ends at the u=0.5 boundary')
    assert.isAtLeast(subV0, 0.5 - 1e-6, 'northern sub-mesh starts at the v=0.5 boundary')

    // Imagery selection is driven by the sub-mesh's own footprint (item.satBbox),
    // strictly smaller than the ancestor tile — not by the ancestor's full bbox.
    // Confirm requestForBbox receives exactly that footprint. The stronger
    // "insufficient coverage forces a fresh request instead of reusing a stale
    // tile" guarantee is covered by the dedicated cache tests and the final
    // manager test in this suite.
    let requestedBbox = null
    const original = cache.requestForBbox.bind(cache)
    cache.requestForBbox = bbox => { requestedBbox = bbox }
    manager.requestSatTiles(VIEWPORT)
    cache.requestForBbox = original
    assert.deepEqual(requestedBbox, item.satBbox,
      'requestForBbox receives the sub-mesh footprint, not the ancestor bbox')
  })

  it('rebuilds UVs against the actual sub-mesh footprint for a non-origin child quadrant', async () => {
    fakeImage = installFakeImage({ hold: url => url.includes('/10/') })
    const { regl, manager, cache, fns } = createManager()
    const a = singleTileDomain(256, 171, 9)
    manager.syncTiles(a.xDomain, a.yDomain, VIEWPORT)
    await settle(manager, cache)
    seedSat(cache, regl, 9, 256, 171)

    // Child (qx=1, qy=0) → DTM UV range [0.5, 0, 1, 0.5]. Its footprint center
    // lies strictly inside the ancestor tile (not on an edge), so center-based
    // tile selection resolves deterministically.
    const b = singleTileDomain(513, 342, 10)
    manager.syncTiles(b.xDomain, b.yDomain, VIEWPORT)
    manager.requestSatTiles(VIEWPORT)
    await settle(manager, cache)

    assert.lengthOf(manager._renderItems, 1)
    const ancestorSlot = manager.tiles.get('9/256/171').slot
    const item = manager._renderItems[0]
    assert.equal(item.slot, ancestorSlot)
    assert.deepEqual(item.range, [0.5, 0, 1, 0.5])
    assert.isTrue(cache._tileCoversBbox(item.sat.bounds, item.satBbox))

    const { uvX, uvY } = uvArraysAt(fns, itemIndexForSlot(manager, ancestorSlot))
    // The UV texture covers the full ancestor slot; the sub-region itself is
    // clipped in the vertex shader via dtmUvRange. So assert that all active UVs
    // are valid and that the sub-mesh's sat footprint maps into the correct
    // texture quadrant ([0.5,1] x [0,0.5]) when normalised against the sat tile.
    assertUvsInUnitRange(uvX, uvY)
    const satBounds = item.sat.bounds
    const bW = satBounds.maxX - satBounds.minX
    const bH = satBounds.maxY - satBounds.minY
    // Sub-mesh footprint in texture coordinates (flipY applied, hence 1 - y).
    const subU0 = (item.satBbox.minX - satBounds.minX) / bW
    const subU1 = (item.satBbox.maxX - satBounds.minX) / bW
    const subV1 = 1.0 - (item.satBbox.minY - satBounds.minY) / bH
    const subV0 = 1.0 - (item.satBbox.maxY - satBounds.minY) / bH
    assert.isAtLeast(subU0, 0.5 - 1e-6, 'sub-mesh starts at the u=0.5 quadrant boundary')
    assert.isAtMost(subU1, 1 + 1e-6)
    // qy=0 is the northern child (high geographic lat → high flipped texture v).
    assert.isAtLeast(subV0, 0.5 - 1e-6, 'northern sub-mesh occupies the top v half')
    assert.isAtMost(subV1, 1 + 1e-6)
  })

  it('does not bind a sat texture to a render item until a covering tile exists', async () => {
    fakeImage = installFakeImage()
    const { regl, manager, cache, fns } = createManager()
    const a = singleTileDomain(256, 171, 9)
    manager.syncTiles(a.xDomain, a.yDomain, VIEWPORT)
    await settle(manager, cache)
    // No sat tiles requested/loaded yet.
    manager._rebuildArrays()

    assert.lengthOf(manager._renderItems, 1)
    assert.isNull(manager._renderItems[0].sat)
    assert.isNull(fns.satTexFns[0](), 'no sat texture closure while imagery is missing')
    assert.isNull(fns.satUvXTexFns[0]())

    // Once a covering sat tile exists and arrays rebuild, it is bound.
    seedSat(cache, regl, 9, 256, 171)
    manager._rebuildArrays()
    assert.isOk(manager._renderItems[0].sat)
    assert.isOk(fns.satTexFns[0]())
    const { uvX, uvY } = uvArraysAt(fns, 0)
    assertUvsInUnitRange(uvX, uvY)
  })

  it('protects the render-item sat texture from eviction while zooming near the cache limit', async () => {
    fakeImage = installFakeImage()
    const { regl, manager, cache, fns } = createManager()
    const a = singleTileDomain(256, 171, 9)
    manager.syncTiles(a.xDomain, a.yDomain, VIEWPORT)
    await settle(manager, cache)
    const retainedSatKey = seedSat(cache, regl, 9, 256, 171)
    manager._rebuildArrays()

    const boundTexture = fns.satTexFns[0]()
    assert.isOk(boundTexture)
    assert.includeMembers([...cache._retainedKeys], [retainedSatKey])

    // Fill the cache to its 50-tile limit with unrelated, non-retained entries.
    let i = 0
    while (cache.tiles.size < 50 && i < 200) {
      const key = `8/${i}/50`
      if (!cache.tiles.has(key)) {
        cache.tiles.set(key, { status: 'loaded', texture: createFakeRegl().texture({}), bounds: tileToMercBbox(i, 50, 8) })
        cache.accessOrder.push(key)
      }
      i++
    }
    assert.equal(cache.tiles.size, 50)

    // A 51st unrelated tile finishes loading and triggers LRU eviction.
    const overflowKey = '7/1/1'
    cache.tiles.set(overflowKey, { status: 'loading' })
    cache.accessOrder.push(overflowKey)
    cache.tiles.set(overflowKey, { status: 'loaded', texture: createFakeRegl().texture({}), bounds: tileToMercBbox(1, 1, 7) })
    cache._evictIfNeeded(overflowKey)

    assert.isFalse(boundTexture.destroyed, 'the texture bound by the current frame must survive')
    assert.isTrue(cache.tiles.has(retainedSatKey), 'retained render tile stays cached')
    assert.strictEqual(fns.satTexFns[0](), boundTexture, 'the closure still resolves to the live texture')
  })

  it('reprojects sat positions when DTM (3857) and sat WMS (4326) CRS differ', async () => {
    fakeImage = installFakeImage()
    const { manager, cache, fns } = createManager({
      dtmCrs: 'EPSG:3857', satCrs: 'EPSG:4326', satSource: WMS_SAT_SOURCE,
    })
    const a = singleTileDomain(256, 171, 9)
    manager.syncTiles(a.xDomain, a.yDomain, VIEWPORT)
    await settle(manager, cache)
    manager.requestSatTiles(VIEWPORT)
    await settle(manager, cache)
    manager._rebuildArrays()

    assert.lengthOf(manager._renderItems, 1)
    const item = manager._renderItems[0]
    // Footprint is in geographic degrees even though the DTM tile is in metres.
    assert.isAtLeast(item.satBbox.minX, -180)
    assert.isAtMost(item.satBbox.maxX, 180)
    assert.isAtLeast(item.satBbox.minY, -85.06)
    assert.isAtMost(item.satBbox.maxY, 85.06)

    assert.isOk(item.sat)
    assert.include(item.sat.key, 'wms:')
    const { uvX, uvY } = uvArraysAt(fns, 0)
    assertUvsInUnitRange(uvX, uvY)
  })

  it('requests new covering sat tiles when the only cached imagery is insufficient', async () => {
    fakeImage = installFakeImage()
    const { regl, manager, cache } = createManager()
    const a = singleTileDomain(256, 171, 9)
    manager.syncTiles(a.xDomain, a.yDomain, VIEWPORT)
    await settle(manager, cache)

    // Seed only a stale z=10 sat tile covering one quadrant of the z=9 DTM tile.
    const staleKey = seedSat(cache, regl, 10, 512, 342)
    const z9 = tileToMercBbox(256, 171, 9)
    assert.isFalse(cache._tileCoversBbox(tileToMercBbox(512, 342, 10), z9))
    manager._rebuildArrays()
    assert.isNull(manager._renderItems[0].sat, 'the partially covering stale tile is not selected')

    const before = fakeImage.requests.length
    manager.requestSatTiles(VIEWPORT)
    await flush()
    assert.isAbove(fakeImage.requests.length, before, 'a new sat request must be issued')

    // Once the freshly requested covering tile settles, it is selected — never the stale one.
    await settle(manager, cache)
    manager._rebuildArrays()
    const selected = manager._renderItems[0].sat
    assert.isOk(selected, 'a covering tile eventually becomes available')
    assert.notEqual(selected.key, staleKey)
    assert.isTrue(cache._tileCoversBbox(selected.bounds, manager._renderItems[0].satBbox))
  })
})

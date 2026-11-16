import { assert } from '@esm-bundle/chai'
import { SatTileCache } from '../src/layers/gis/ImageTerrainImpl.js'
import { tileToMercBbox, mercToTileXY } from '../src/layers/gis/TileLayer.js'
import { createFakeRegl, installFakeImage, flush } from './helpers/fake-regl.js'

const XYZ_SOURCE = { type: 'xyz', url: 'https://tiles.example/{z}/{x}/{y}.png', minZoom: 0, maxZoom: 19 }
const WMS_SOURCE = { type: 'wms', url: 'https://wms.example/map', layers: 'img', minZoom: 0, maxZoom: 19 }

// Seed a loaded tile directly into the cache (bypasses image loading and zoom math).
function seedLoaded(cache, regl, z, tx, ty) {
  const key = `${z}/${tx}/${ty}`
  cache.tiles.set(key, {
    status: 'loaded',
    texture: regl.texture({}),
    bounds: tileToMercBbox(tx, ty, z),
  })
  cache.accessOrder.push(key)
  return key
}

// Wait until the cache finishes all currently in-flight tile loads.
async function settle(cache, spins = 10) {
  for (let i = 0; i < spins; i++) {
    if ([...cache.tiles.values()].every(t => t.status === 'loaded')) break
    await flush()
  }
}

function loadedKeys(cache) {
  return [...cache.tiles.entries()].filter(([, t]) => t.status === 'loaded').map(([k]) => k)
}

describe('SatTileCache — coverage-aware selection and safe eviction', () => {
  let regl, fakeImage

  beforeEach(() => {
    regl = createFakeRegl()
    fakeImage = installFakeImage()
  })

  afterEach(() => {
    fakeImage.restore()
  })

  it('reuses a cached ancestor tile only when it fully covers the requested bbox', () => {
    const cache = new SatTileCache({ regl, source: XYZ_SOURCE, satTileCrs: 'EPSG:3857', onLoad: () => {} })

    // Footprint of a z=10 DTM sub-mesh; the z=9 ancestor tile fully contains it.
    const z10 = tileToMercBbox(512, 342, 10)
    const ancestorKey = seedLoaded(cache, regl, 9, 256, 171)

    const best = cache.getBestAvailable(z10)
    assert.isOk(best, 'a covering ancestor should be selected while the target loads')
    assert.equal(best.key, ancestorKey)
    assert.isTrue(cache._tileCoversBbox(best.bounds, z10))
  })

  it('refuses a cached tile that covers only part of the bbox and requests covering tiles instead', async () => {
    const cache = new SatTileCache({ regl, source: XYZ_SOURCE, satTileCrs: 'EPSG:3857', onLoad: () => {} })

    // A z=10 footprint with a stale z=11 tile containing its center but covering
    // only a quarter of it (leftover from an earlier, more zoomed-in view).
    const z10 = tileToMercBbox(512, 342, 10)
    const [cx, cy] = mercToTileXY((z10.minX + z10.maxX) / 2, (z10.minY + z10.maxY) / 2, 11)
    const staleKey = seedLoaded(cache, regl, 11, cx, cy)
    assert.isFalse(cache._tileCoversBbox(tileToMercBbox(cx, cy, 11), z10),
      'fixture sanity: the z=11 tile must not cover the z=10 bbox')

    // Selection must NOT return the partially covering stale tile.
    assert.isNull(cache.getBestAvailable(z10),
      'a partially covering cached tile must never be selected')

    // Requesting imagery must fire fresh requests rather than reuse the stale tile.
    const before = fakeImage.requests.length
    cache.requestForBbox(z10, { width: 512, height: 512 })
    await flush()
    assert.isAbove(fakeImage.requests.length, before, 'new tile requests must be fired')

    // Every freshly requested tile is at the bbox-appropriate zoom (z=10), never z=11.
    const freshKeys = [...cache.tiles.keys()].filter(k => k !== staleKey)
    assert.isAbove(freshKeys.length, 0)
    for (const key of freshKeys) assert.match(key, /^10\//)

    // Once the covering z=10 tile settles, selection returns it, not the stale one.
    await settle(cache)
    const best = cache.getBestAvailable(z10)
    assert.isOk(best)
    assert.notEqual(best.key, staleKey)
    assert.isTrue(cache._tileCoversBbox(best.bounds, z10))
  })

  it('requests all four tiles when a bbox straddles a tile corner at the request zoom', async () => {
    const cache = new SatTileCache({ regl, source: XYZ_SOURCE, satTileCrs: 'EPSG:3857', onLoad: () => {} })

    // Corner shared by z=10 tiles (512,342),(513,342),(512,343),(513,343).
    const left = tileToMercBbox(512, 342, 10)
    const cornerX = left.maxX
    const cornerY = left.minY
    const tileW = left.maxX - left.minX
    // Cross both edges but keep the center slightly inside tile (513,343), so
    // center-based selection still resolves to a concrete tile after settling.
    const reach = tileW * 0.4
    const straddle = {
      minX: cornerX - reach, maxX: cornerX + reach,
      minY: cornerY - reach, maxY: cornerY + reach,
    }
    // Shift center off the exact corner into the (513,343) quadrant.
    straddle.maxX += tileW * 0.05
    straddle.minY -= tileW * 0.05

    cache.requestForBbox(straddle, { width: 512, height: 512 })
    await flush()
    const keys = [...cache.tiles.keys()]
    assert.lengthOf(keys, 4, 'the 2x2 tile neighbourhood around the corner must be requested')
    const expected = new Set(['10/512/342', '10/513/342', '10/512/343', '10/513/343'])
    for (const key of keys) {
      assert.isTrue(expected.has(key), `unexpected requested tile ${key}`)
      const [z] = key.split('/').map(Number)
      assert.equal(z, 10)
    }
    // The union of the four loaded tiles covers the whole straddling bbox —
    // no coverage gap even though no single tile contains all of it.
    await settle(cache)
    const union = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    for (const key of keys) {
      const b = cache.tiles.get(key).bounds
      union.minX = Math.min(union.minX, b.minX)
      union.maxX = Math.max(union.maxX, b.maxX)
      union.minY = Math.min(union.minY, b.minY)
      union.maxY = Math.max(union.maxY, b.maxY)
    }
    assert.isTrue(cache._tileCoversBbox(union, straddle), 'the four-tile union covers the bbox')
  })

  it('does not request a tile that is already loading or loaded', async () => {
    const cache = new SatTileCache({ regl, source: XYZ_SOURCE, satTileCrs: 'EPSG:3857', onLoad: () => {} })
    const z10 = tileToMercBbox(512, 342, 10)

    cache.requestForBbox(z10, { width: 512, height: 512 })
    await flush()
    const firstRound = fakeImage.requests.length
    assert.isAbove(firstRound, 0)

    cache.requestForBbox(z10, { width: 512, height: 512 })
    await settle(cache)
    cache.requestForBbox(z10, { width: 512, height: 512 })
    assert.equal(fakeImage.requests.length, firstRound, 'duplicate requests for cached keys are suppressed')
  })

  it('never evicts a tile retained by the current frame, even past the cache limit', () => {
    const cache = new SatTileCache({ regl, source: XYZ_SOURCE, satTileCrs: 'EPSG:3857', onLoad: () => {} })
    const MAX = 50

    // Fill the cache with 50 loaded tiles at z=8, in insertion order.
    for (let i = 0; i < MAX; i++) seedLoaded(cache, regl, 8, 10 + i, 100)
    assert.equal(cache.tiles.size, MAX)

    // The render frame retains the oldest entry (head of the LRU list).
    const retainedKey = cache.accessOrder[0]
    cache.markKeysForRendering(new Set([retainedKey]))
    const retainedTexture = cache.tiles.get(retainedKey).texture

    // A 51st tile finishes loading: ordinary LRU would drop the retained head entry.
    const extraKey = seedLoaded(cache, regl, 8, 200, 200)
    cache._evictIfNeeded(extraKey)

    assert.isTrue(cache.tiles.has(retainedKey), 'retained render tile must survive eviction')
    assert.isFalse(retainedTexture.destroyed, 'the retained texture must not be destroyed')
    assert.equal(cache.tiles.size, MAX, 'one non-retained tile is dropped to make room')
  })

  it('evicts non-retained tiles in LRU order and honors retention updates on later frames', () => {
    const cache = new SatTileCache({ regl, source: XYZ_SOURCE, satTileCrs: 'EPSG:3857', onLoad: () => {} })
    const MAX = 50
    for (let i = 0; i < MAX + 1; i++) seedLoaded(cache, regl, 8, i, 10)

    // Nothing retained yet: plain LRU eviction drops the oldest entry.
    const lastKey = cache.accessOrder[cache.accessOrder.length - 1]
    cache._evictIfNeeded(lastKey)
    assert.equal(cache.tiles.size, MAX)
    assert.isFalse(cache.tiles.has('8/0/10'), 'oldest unretained entry is evicted first')

    // Next frame retains nothing — the new head should now be evictable.
    cache.markKeysForRendering(new Set())
    const nextHead = cache.accessOrder[0]
    const key2 = seedLoaded(cache, regl, 8, 300, 300)
    cache._evictIfNeeded(key2)
    assert.isFalse(cache.tiles.has(nextHead), 'cleared retention allows LRU eviction again')
  })

  it('keeps WMS behaviour unchanged: one request per bbox key, key-based selection', async () => {
    const cache = new SatTileCache({ regl, source: WMS_SOURCE, satTileCrs: 'EPSG:3857', onLoad: () => {} })
    const bbox = tileToMercBbox(512, 342, 10)

    assert.isNull(cache.getBestAvailable(bbox), 'no WMS tile before loading')
    cache.requestForBbox(bbox, { width: 256, height: 256 })
    cache.requestForBbox(bbox, { width: 256, height: 256 })
    assert.equal(fakeImage.requests.length, 1, 'WMS dedupes on the bbox key')
    await settle(cache)

    const best = cache.getBestAvailable(bbox)
    assert.isOk(best)
    assert.include(best.key, 'wms:')
    assert.deepEqual(best.bounds, bbox)
    assert.includeMembers(loadedKeys(cache), [best.key])
  })
})

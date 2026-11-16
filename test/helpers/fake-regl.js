// Minimal regl stub for tile-manager unit tests: no WebGL context is needed to
// exercise tile selection, coverage and eviction logic — only texture bookkeeping.
// Each "texture" is a plain object recording whether it is still alive and the
// array it was created from (so tests can read back computed sat UVs).

export class FakeTexture {
  constructor(opts = {}) {
    this.data = opts.data ?? null
    this.width = opts.width ?? (this.data?.length ?? 1)
    this.height = opts.height ?? 1
    this.destroyed = false
  }

  destroy() {
    this.destroyed = true
  }
}

export function createFakeRegl() {
  return {
    limits: { maxTextureSize: 4096 },
    texture(opts) {
      return new FakeTexture(opts)
    },
  }
}

// Controllable Image stub. `hold(url) => true` keeps an image pending (the tile
// stays in the manager's/cache's "loading" state) until releaseAll() is called,
// letting tests model "target tile still loading, ancestor already loaded".
const REAL_IMAGE = globalThis.Image

export function installFakeImage({ hold = () => false } = {}) {
  const requests = []
  const pending = []

  class FakeImage {
    constructor() {
      this.onload = null
      this.onerror = null
      this.crossOrigin = null
      this.width = 1
      this.height = 1
    }

    set src(url) {
      this._url = url
      const entry = { url, img: this }
      requests.push(entry)
      if (hold(url)) {
        pending.push(entry)
        return
      }
      // Resolve asynchronously to mirror real image loading.
      Promise.resolve().then(() => {
        if (this.onload) this.onload({ target: this })
      })
    }

    get src() {
      return this._url
    }
  }

  globalThis.Image = FakeImage
  return {
    requests,
    pending,
    releaseAll() {
      const entries = pending.splice(0)
      for (const entry of entries) {
        if (entry.img.onload) entry.img.onload({ target: entry.img })
      }
    },
    restore() {
      globalThis.Image = REAL_IMAGE
    },
  }
}

// Flush the promise chain so any pending fake-image onload callbacks settle.
export function flush() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

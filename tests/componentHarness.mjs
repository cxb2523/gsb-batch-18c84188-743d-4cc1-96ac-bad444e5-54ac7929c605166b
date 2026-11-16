/**
 * 用最小假 DOM 跑 src/canvasPlayer.vue 的进度/播放控制方法。
 *
 * 这样可以在 Node 里直接验证：
 *   - 跳转是否把“段内偏移”正确交给播放逻辑
 *   - 暂停态跳转是否保持暂停
 *   - 片尾重播是否回到第一段开头
 *   - 跳转后当前段与预加载段的起点
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TIME_EPSILON,
  normalizePlaylist,
  buildTimeline,
  resolveSeekTarget,
  getPlaybackTarget,
  advancePlayback,
  restartPlayback,
} from '../src/playback.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VUE_FILE = path.resolve(__dirname, '../src/canvasPlayer.vue')

// ---------------------------------------------------------------------------
// 假 DOM
// ---------------------------------------------------------------------------
class FakeElement {
  constructor(tagName, id) {
    this.tagName = tagName
    this.id = id || ''
    this.children = []
    this.style = {}
    this.width = 0
    this.height = 0
    this.listeners = {}
    this.parentNode = null
    this.offsetWidth = 400
    this.clientWidth = 400
    this.readyState = 0
    this.currentTime = 0
    this.paused = true
    this.ended = false
    this.seeking = false
    this.videoWidth = 1080
    this.videoHeight = 1920
    this.volume = 0
    this.muted = false
    this.duration = 30
    this._src = ''
    this.srcSetCount = 0
    this.playCalls = 0
    this.pauseCalls = 0
  }
  get src() {
    return this._src
  }
  set src(value) {
    // 记录赋值次数，用于验证“同一视频源不重复加载”
    this.srcSetCount++
    this._src = value
  }
  get className() {
    return this._className || ''
  }
  set className(value) {
    this._className = value
  }
  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    allNodes.push(child)
    return child
  }
  removeChild(child) {
    this.children = this.children.filter((item) => item !== child)
    const at = allNodes.indexOf(child)
    if (at >= 0) allNodes.splice(at, 1)
    return child
  }
  addEventListener(name, handler) {
    ;(this.listeners[name] || (this.listeners[name] = [])).push(handler)
  }
  removeEventListener(name, handler) {
    const list = this.listeners[name] || []
    this.listeners[name] = list.filter((item) => item !== handler)
  }
  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      right: this.offsetWidth,
      bottom: 10,
      width: this.offsetWidth,
      height: 10,
    }
  }
  getContext() {
    if (!this._context) {
      this.drawCount = 0
      this._context = {
        drawImage: () => {
          this.drawCount++
        },
      }
    }
    return this._context
  }
  play() {
    this.playCalls++
    this.paused = false
    this.ended = false
    return Promise.resolve()
  }
  pause() {
    this.pauseCalls++
    this.paused = true
  }
  // 测试辅助：模拟元数据就绪
  finishMetadata() {
    this.readyState = 4
    if (typeof this.onloadedmetadata === 'function') this.onloadedmetadata()
  }
  // 测试辅助：模拟浏览器完成 seek
  finishSeek() {
    this.seeking = false
    if (typeof this.onseeked === 'function') this.onseeked()
  }
}

let allNodes = []
let selectorMap = {}

function setupDom() {
  allNodes = []
  selectorMap = {}
  const videoDom = new FakeElement('div', 'VideoDom')
  const canvasDom = new FakeElement('div', 'canvasDom')
  videoDom.appendChild(canvasDom)
  const progressBar = new FakeElement('div', 'progressBar')
  progressBar.clientWidth = 400
  const bar = new FakeElement('div')
  bar.offsetWidth = 400
  bar.className = 'bar'
  const circle = new FakeElement('div', 'circle')
  bar.appendChild(circle)
  progressBar.appendChild(bar)
  canvasDom.appendChild(progressBar)
  const canvas = new FakeElement('canvas', 'AutoCanvasId')
  canvasDom.appendChild(canvas)
  selectorMap['#VideoDom'] = videoDom
  selectorMap['#canvasDom'] = canvasDom
  selectorMap['#progressBar'] = progressBar
  selectorMap['#circle'] = circle
  selectorMap['.bar'] = bar
  selectorMap['#AutoCanvasId'] = canvas
  return { videoDom, canvasDom, progressBar, bar, circle, canvas }
}

globalThis.document = {
  getElementById(id) {
    return allNodes.find((el) => el.id === id) || null
  },
  querySelector(selector) {
    return selectorMap[selector] || null
  },
  createElement(tagName) {
    return new FakeElement(tagName)
  },
  getElementsByTagName(tagName) {
    const tag = String(tagName).toLowerCase()
    return allNodes.filter((el) => el.tagName.toLowerCase() === tag)
  },
  addEventListener() {},
  removeEventListener() {},
  body: new FakeElement('body'),
}

globalThis.window = {
  requestAnimationFrame() {
    return 1
  },
  cancelAnimationFrame() {},
}

// ---------------------------------------------------------------------------
// 从 .vue 中取出 script 并装配成可调用的组件对象
// ---------------------------------------------------------------------------
function loadComponentOptions() {
  const source = fs.readFileSync(VUE_FILE, 'utf8')
  const match = source.match(/<script setup>([\s\S]*?)<\/script>/)
  if (!match) throw new Error('未能从 canvasPlayer.vue 中提取 <script setup>')
  const body = match[1]
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/playback\.mjs'/, '')
    .replace('export default', 'const __componentOptions =')
  const factory = new Function(
    'TIME_EPSILON',
    'normalizePlaylist',
    'buildTimeline',
    'resolveSeekTarget',
    'getPlaybackTarget',
    'advancePlayback',
    'restartPlayback',
    `${body}\nreturn __componentOptions`
  )
  return factory(
    TIME_EPSILON,
    normalizePlaylist,
    buildTimeline,
    resolveSeekTarget,
    getPlaybackTarget,
    advancePlayback,
    restartPlayback
  )
}

// 用组件自身的 data()/methods 组装一个“实例”
function createInstance(list) {
  const options = loadComponentOptions()
  const instance = options.data()
  instance.list = list
  instance.videoList = list
  instance.playerlist = normalizePlaylist(list)
  for (const [name, method] of Object.entries(options.methods)) {
    instance[name] = method.bind(instance)
  }
  Object.defineProperty(instance, 'progressPercent', {
    get: () => options.computed.progressPercent.call(instance),
  })
  instance.$nextTick = (cb) => {
    if (typeof cb === 'function') cb()
  }
  instance.$destroy = () => {}
  instance.$el = { parentNode: null }
  instance.setFree = () => {}
  const timeline = buildTimeline(instance.playerlist)
  instance.skipDict = timeline.cumulativeEnds
  instance.totalTime = timeline.totalTime
  return instance
}

// VideoPlay 是 async 函数，内部有若干 await；这里把微任务队列冲干净
async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

// 驱动一次完整的“跳转 -> 元数据就绪 -> seek 完成”
async function runSeek(instance, time, autoPlay) {
  const dom = setupDom()
  instance.dropInited = false
  instance.seekTo(time, autoPlay)
  await flush()
  const current = document.getElementById('AutoVideoId')
  const preload = document.getElementById('preLoadVideoId')
  if (current) {
    current.finishMetadata()
    await flush()
    current.finishSeek()
    current.finishMetadata()
    await flush()
  }
  if (preload) {
    preload.finishMetadata()
    await flush()
  }
  return { ...dom, current, preload }
}

const LIST = [
  {
    url: 'a.mp4',
    width: 1080,
    height: 1920,
    logoPosition: { x: 'left', y: 'top' },
    playPoint: { start: '0', end: '3.120000' },
  },
  {
    url: 'b.mp4',
    width: 1080,
    height: 1920,
    logoPosition: { x: 'right', y: 'top' },
    playPoint: { start: '4.320000', end: '10.200000' },
  },
  {
    url: 'c.mp4',
    width: 1080,
    height: 1920,
    logoPosition: { x: 'left', y: 'bottom' },
    playPoint: { start: '11.400000', end: '20.320000' },
  },
  {
    url: 'd.mp4',
    width: 1080,
    height: 1920,
    logoPosition: { x: 'right', y: 'bottom' },
    playPoint: { start: '21.520000', end: '24.72' },
  },
]

export {
  FakeElement,
  setupDom,
  loadComponentOptions,
  createInstance,
  runSeek,
  flush,
  LIST,
}

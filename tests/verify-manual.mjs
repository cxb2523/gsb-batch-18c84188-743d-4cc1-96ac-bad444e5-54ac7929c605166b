/**
 * 本地手动验证脚本：node tests/verify-manual.mjs
 *
 * 直接使用 src/data.js 的示例片段，逐条打印跳转 / 边界 / 重播 / 预加载的结果，
 * 便于对照播放器里的实际表现。断言部分由 tests/*.test.mjs 覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizePlaylist,
  buildTimeline,
  resolveSeekTarget,
  getPlaybackTarget,
  advancePlayback,
  restartPlayback,
} from '../src/playback.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// src/data.js 是给 webpack 用的 ESM；这里直接取默认导出对象，避免额外的模块类型告警
function loadDemoData() {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/data.js'), 'utf8')
  const body = source
    .replace(/export\s+default\s+/, 'return ')
    .replace(/^const\s+videoObj\s*=\s*/m, 'return ')
  return new Function(body)()
}

const demo = loadDemoData()

const segments = normalizePlaylist(demo.list)
const { totalTime, cumulativeEnds } = buildTimeline(segments)

const fixed = (value) => value.toFixed(3)
const fmt = (value) => `${fixed(value)}s`

function printPlaylist() {
  console.log('示例片段（来自 src/data.js）')
  demo.list.forEach((item, i) => {
    const seg = segments[i]
    console.log(
      `  第 ${i + 1} 段 ${item.url.split('/').pop()}  ` +
        `start=${fmt(seg.start)} end=${fmt(seg.end)} 时长=${fmt(seg.duration)}  ` +
        `累计终点=${fmt(cumulativeEnds[i])}`
    )
  })
  console.log(`  总时长 = ${fmt(totalTime)}\n`)
}

function describeSeek(label, time, autoPlay) {
  const target = resolveSeekTarget(cumulativeEnds, totalTime, time)
  console.log(`${label}：目标 ${fmt(time)}`)
  if (target.atEnd) {
    console.log(
      `  -> 停在最后一段（下标 ${target.index}）末尾，atEnd=true，` +
        `进度显示 ${fmt(target.playedTime)}，不自动播放\n`
    )
    return
  }
  const playback = getPlaybackTarget(segments, target.index, target.offset)
  console.log(
    `  -> 第 ${target.index + 1} 段，段内偏移 ${fmt(target.offset)}，` +
      `视频定位到 ${fmt(playback.startTime)}，结束于 ${fmt(playback.endTime)}`
  )
  console.log(
    `  -> 进度条 ${fmt(target.playedTime)}，${autoPlay ? '定位后继续播放' : '保持暂停'}` +
      `，预加载第 ${playback.nextIndex + 1} 段起点 ${fmt(playback.nextStartTime)}\n`
  )
}

console.log('=== 1. 正常跳转 ===')
describeSeek('拖到第 2 段中间', 5, true)
describeSeek('拖到第 4 段中间', 21, true)

console.log('=== 2. 边界跳转 ===')
describeSeek('拖到第一段开头', 0, true)
describeSeek('拖到第 1 段累计终点', cumulativeEnds[0], true)
describeSeek('拖到第 3 段累计终点', cumulativeEnds[2], true)
describeSeek('拖到最后一段末尾', totalTime, true)
describeSeek('拖过总时长（钳制）', totalTime + 3, true)

console.log('=== 3. 片尾重播 ===')
const ended = advancePlayback(cumulativeEnds, totalTime, segments.length - 1)
console.log(
  `最后一段播完：playIndex=${ended.index}（= 片段数），` +
    `进度 ${fmt(ended.playedTime)}，结束标记 ${ended.ended}`
)
const restart = restartPlayback()
console.log(
  `再次点播放：playIndex=${restart.index}，进度 ${fmt(restart.playedTime)}，` +
    `结束标记 ${restart.ended}，从第 1 段开头重新开始\n`
)

console.log('=== 4. 跳转后的预加载起点 ===')
const middle = resolveSeekTarget(cumulativeEnds, totalTime, 12)
const playback = getPlaybackTarget(segments, middle.index, middle.offset)
console.log(
  `跳到 ${fmt(12)} -> 第 ${middle.index + 1} 段（偏移 ${fmt(middle.offset)}），` +
    `预加载第 ${playback.nextIndex + 1} 段起点 ${fmt(playback.nextStartTime)}（` +
    `第 ${playback.nextIndex + 1} 段配置 start）`
)

const lastSeek = resolveSeekTarget(cumulativeEnds, totalTime, 21)
const lastPlayback = getPlaybackTarget(segments, lastSeek.index, lastSeek.offset)
console.log(
  `跳到 ${fmt(21)} -> 最后一段，预加载回绕到第 ${lastPlayback.nextIndex + 1} 段 ` +
    `起点 ${fmt(lastPlayback.nextStartTime)}\n`
)

printPlaylist()

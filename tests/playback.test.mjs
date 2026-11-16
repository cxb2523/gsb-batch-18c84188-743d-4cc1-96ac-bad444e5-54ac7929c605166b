import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TIME_EPSILON,
  normalizePlaylist,
  buildTimeline,
  resolveSeekTarget,
  getPlaybackTarget,
  advancePlayback,
  restartPlayback,
} from '../src/playback.mjs'

// 与 src/data.js 相同的四段配置（总时长 21.12s）
const RAW_LIST = [
  { playPoint: { start: '0', end: '3.120000' } },
  { playPoint: { start: '4.320000', end: '10.200000' } },
  { playPoint: { start: '11.400000', end: '20.320000' } },
  { playPoint: { start: '21.520000', end: '24.72' } },
]
const SEGMENTS = normalizePlaylist(RAW_LIST)
const { totalTime, cumulativeEnds } = buildTimeline(SEGMENTS)

test('normalizePlaylist 把字符串 playPoint 解析成数字区间', () => {
  assert.deepEqual(SEGMENTS[0], { start: 0, end: 3.12, duration: 3.12 })
  assert.equal(SEGMENTS[1].start, 4.32)
  assert.equal(SEGMENTS[3].end, 24.72)
})

test('buildTimeline 累计总时长与各段累计终点', () => {
  assert.ok(Math.abs(totalTime - 21.12) < TIME_EPSILON)
  assert.equal(cumulativeEnds.length, 4)
  assert.ok(Math.abs(cumulativeEnds[0] - 3.12) < TIME_EPSILON)
  assert.ok(Math.abs(cumulativeEnds[1] - 9) < TIME_EPSILON)
  assert.ok(Math.abs(cumulativeEnds[3] - 21.12) < TIME_EPSILON)
})

test('正常跳转：落在某段中间时返回正确的段下标与段内偏移', () => {
  // 全局 5s -> 第 2 段（累计起点 3.12），段内偏移 1.88
  const target = resolveSeekTarget(cumulativeEnds, totalTime, 5)
  assert.equal(target.index, 1)
  assert.ok(Math.abs(target.offset - (5 - 3.12)) < TIME_EPSILON)
  assert.ok(Math.abs(target.playedTime - 5) < TIME_EPSILON)
  assert.equal(target.atEnd, false)

  // 第 4 段中间
  const last = resolveSeekTarget(cumulativeEnds, totalTime, 21)
  assert.equal(last.index, 3)
  assert.ok(Math.abs(last.offset - (21 - 17.92)) < TIME_EPSILON)
  assert.equal(last.atEnd, false)
})

test('边界跳转：0 落在第一段开头', () => {
  const target = resolveSeekTarget(cumulativeEnds, totalTime, 0)
  assert.deepEqual(target, { index: 0, offset: 0, playedTime: 0, atEnd: false })
})

test('边界跳转：恰好等于某段累计终点时归入下一段开头', () => {
  for (let i = 0; i < cumulativeEnds.length - 1; i++) {
    const target = resolveSeekTarget(cumulativeEnds, totalTime, cumulativeEnds[i])
    assert.equal(target.index, i + 1, `累计终点 ${cumulativeEnds[i]} 应落到下一段`)
    assert.ok(Math.abs(target.offset) < TIME_EPSILON)
    assert.ok(Math.abs(target.playedTime - cumulativeEnds[i]) < TIME_EPSILON)
    assert.equal(target.atEnd, false)
  }
})

test('边界跳转：恰好等于 / 超过总时长停在最后一段末尾，不越界', () => {
  for (const time of [totalTime, totalTime + 5, Number.MAX_SAFE_INTEGER]) {
    const target = resolveSeekTarget(cumulativeEnds, totalTime, time)
    assert.equal(target.index, 3)
    assert.equal(target.atEnd, true)
    assert.ok(Math.abs(target.playedTime - totalTime) < TIME_EPSILON)
    assert.ok(target.offset <= SEGMENTS[3].duration + TIME_EPSILON)
  }
})

test('边界跳转：负数时间回到第一段开头', () => {
  const target = resolveSeekTarget(cumulativeEnds, totalTime, -10)
  assert.deepEqual(target, { index: 0, offset: 0, playedTime: 0, atEnd: false })
})

test('边界跳转：空时间轴不会返回不存在的片段', () => {
  assert.deepEqual(resolveSeekTarget([], 0, 5), {
    index: 0,
    offset: 0,
    playedTime: 0,
    atEnd: true,
  })
})

test('跳转后的播放参数：当前段起点 = 片段起点 + 段内偏移', () => {
  const target = resolveSeekTarget(cumulativeEnds, totalTime, 5)
  const playback = getPlaybackTarget(SEGMENTS, target.index, target.offset)
  assert.equal(playback.index, 1)
  assert.ok(Math.abs(playback.startTime - (4.32 + 1.88)) < TIME_EPSILON)
  assert.equal(playback.endTime, 10.2)
})

test('跳转后的预加载起点：按目标片段重新计算下一段起点', () => {
  const target = resolveSeekTarget(cumulativeEnds, totalTime, 5)
  const playback = getPlaybackTarget(SEGMENTS, target.index, target.offset)
  assert.equal(playback.nextIndex, 2)
  assert.equal(playback.nextStartTime, 11.4)
  assert.equal(playback.nextEndTime, 20.32)

  // 跳到倒数第二段时，预加载的是最后一段
  const secondLast = getPlaybackTarget(SEGMENTS, 2, 1)
  assert.equal(secondLast.nextIndex, 3)
  assert.equal(secondLast.nextStartTime, 21.52)

  // 最后一段播放时回绕预加载第一段
  const last = getPlaybackTarget(SEGMENTS, 3, 0)
  assert.equal(last.nextIndex, 0)
  assert.equal(last.nextStartTime, 0)
})

test('偏移越界时被钳制在该段时长内', () => {
  const playback = getPlaybackTarget(SEGMENTS, 1, 999)
  assert.ok(Math.abs(playback.offset - SEGMENTS[1].duration) < TIME_EPSILON)
  assert.ok(Math.abs(playback.startTime - SEGMENTS[1].end) < TIME_EPSILON)

  const negative = getPlaybackTarget(SEGMENTS, 1, -5)
  assert.equal(negative.offset, 0)
  assert.equal(negative.startTime, SEGMENTS[1].start)
})

test('段落推进：中间段落推进到下一段累计起点', () => {
  const state = advancePlayback(cumulativeEnds, totalTime, 1)
  assert.deepEqual(state, {
    index: 2,
    playedTime: cumulativeEnds[1],
    ended: false,
    paused: false,
  })
})

test('段落推进：最后一段播完进入结束状态且不越界', () => {
  const state = advancePlayback(cumulativeEnds, totalTime, 3)
  assert.equal(state.index, 4)
  assert.equal(state.ended, true)
  assert.equal(state.paused, true)
  assert.ok(Math.abs(state.playedTime - totalTime) < TIME_EPSILON)
})

test('片尾重播状态：第一段开头、进度归零、结束标记清除', () => {
  assert.deepEqual(restartPlayback(), {
    index: 0,
    playedTime: 0,
    ended: false,
    paused: false,
  })
})

test('单段/零时长片段：不会返回不存在的片段', () => {
  // 只有一段
  const single = resolveSeekTarget([5], 5, 99)
  assert.equal(single.index, 0)
  assert.equal(single.atEnd, true)
  assert.ok(Math.abs(single.playedTime - 5) < TIME_EPSILON)

  // 末尾是零时长片段：回落到最后一个有效片段（[3,3,3] 表示只有第 1 段有内容）
  const withEmptyTail = resolveSeekTarget([3, 3, 3], 3, 3)
  assert.equal(withEmptyTail.index, 0)
  assert.equal(withEmptyTail.atEnd, true)
})

test('零时长片段不会吞掉边界时间', () => {
  // 第二段时长为 0：累计终点 [3, 3, 8]
  const target = resolveSeekTarget([3, 3, 8], 8, 3)
  // 3s 落在第 3 段开头，而不是零时长的第 2 段
  assert.equal(target.index, 2)
  assert.ok(Math.abs(target.offset) < TIME_EPSILON)
})

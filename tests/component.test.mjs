import test from 'node:test'
import assert from 'node:assert/strict'

import { TIME_EPSILON } from '../src/playback.mjs'
import { createInstance, runSeek, flush, LIST, setupDom } from './componentHarness.mjs'

const TOTAL = 21.12

test('正常跳转：拖到第 2 段中间，视频从段内偏移处继续，进度一致', async () => {
  const instance = createInstance(LIST)
  const { current, preload } = await runSeek(instance, 5, true)

  assert.equal(instance.playIndex, 1)
  // 视频起点 = 第 2 段配置的 start(4.32) + 段内偏移(1.88)
  assert.ok(Math.abs(current.currentTime - 6.2) < TIME_EPSILON)
  assert.ok(Math.abs(instance.playedTime - 5) < TIME_EPSILON)
  assert.equal(instance.paused, false)
  assert.equal(current.paused, false)
  // 进度条百分比与全局进度一致
  assert.ok(Math.abs(instance.progressPercent - (5 / TOTAL) * 100) < 1e-6)
  // 下一段预加载起点 = 第 3 段起点
  assert.equal(preload.src, 'c.mp4')
  assert.ok(Math.abs(preload.currentTime - 11.4) < TIME_EPSILON)
})

test('正常跳转：跳到第 4 段中间', async () => {
  const instance = createInstance(LIST)
  const { current, preload } = await runSeek(instance, 21, true)
  assert.equal(instance.playIndex, 3)
  assert.ok(Math.abs(current.currentTime - (21.52 + (21 - 17.92))) < TIME_EPSILON)
  assert.ok(Math.abs(instance.playedTime - 21) < TIME_EPSILON)
  // 最后一段的预加载回绕到第一段开头
  assert.equal(preload.src, 'a.mp4')
  assert.ok(Math.abs(preload.currentTime) < TIME_EPSILON)
})

test('暂停态点击进度条跳转：保持暂停，画面停在目标帧', async () => {
  const instance = createInstance(LIST)
  instance.paused = true
  const { current } = await runSeek(instance, 5, false)

  assert.equal(instance.playIndex, 1)
  assert.equal(instance.paused, true)
  assert.equal(current.paused, true)
  assert.equal(current.playCalls, 0)
  assert.ok(Math.abs(current.currentTime - 6.2) < TIME_EPSILON)
  assert.ok(Math.abs(instance.playedTime - 5) < TIME_EPSILON)
  // 目标帧已经画到 canvas 上
  const canvas = document.getElementById('AutoCanvasId')
  assert.ok(canvas.drawCount >= 1)
})

test('片段边界：恰好等于某段累计终点，归入下一段开头', async () => {
  for (let i = 0; i < 3; i++) {
    const instance = createInstance(LIST)
    const boundary = instance.skipDict[i]
    const { current } = await runSeek(instance, boundary, true)
    assert.equal(instance.playIndex, i + 1)
    // 下一段从其配置起点开始（段内偏移 0）
    assert.ok(Math.abs(current.currentTime - instance.playerlist[i + 1].start) < TIME_EPSILON)
    assert.ok(Math.abs(instance.playedTime - boundary) < TIME_EPSILON)
  }
})

test('片段边界：拖到第一段开头从 0 开始', async () => {
  const instance = createInstance(LIST)
  const { current } = await runSeek(instance, 0, true)
  assert.equal(instance.playIndex, 0)
  assert.equal(instance.playedTime, 0)
  assert.ok(Math.abs(current.currentTime) < TIME_EPSILON)
  assert.equal(instance.endFlag, false)
})

test('片段边界：拖到最后一段末尾不会越界到不存在的片段', async () => {
  const instance = createInstance(LIST)
  setupDom()
  instance.seekTo(TOTAL, true)
  await flush()
  const current = document.getElementById('AutoVideoId')
  current.finishMetadata()
  await flush()
  current.finishSeek()
  await flush()

  // 停在最后一段（下标 3）的末尾，不会被推进到 length 这种不存在的片段
  assert.equal(instance.playIndex, LIST.length - 1)
  assert.equal(instance.endFlag, true)
  assert.equal(instance.paused, true)
  assert.ok(Math.abs(instance.playedTime - TOTAL) < TIME_EPSILON)
  // 画面停在末尾前一点点（回退半帧，保证能取到可绘制的最后一帧），不越界
  const lastEnd = LIST[3].playPoint.end * 1
  assert.ok(current.currentTime <= lastEnd + TIME_EPSILON)
  assert.ok(current.currentTime > lastEnd - 0.1)
  // 末尾不应自动播放
  assert.equal(current.playCalls, 0)
})

test('片尾重播：全部播完后再次播放，从第一段开头开始', async () => {
  const instance = createInstance(LIST)
  // 先模拟最后一段播完
  instance.playIndex = LIST.length - 1
  instance.playedTime = TOTAL - 0.2
  instance.endFlag = false
  instance.paused = false
  instance.playNext({ pause() {} })
  await flush()

  assert.equal(instance.endFlag, true)
  assert.equal(instance.playIndex, LIST.length)
  assert.ok(Math.abs(instance.playedTime - TOTAL) < TIME_EPSILON)

  // 再次触发播放 -> 重播
  setupDom()
  instance.changeVideoState()
  await flush()
  const current = document.getElementById('AutoVideoId')
  current.finishMetadata()
  await flush()
  current.finishSeek()
  await flush()

  assert.equal(instance.endFlag, false, '结束标记必须被清除')
  assert.equal(instance.playIndex, 0)
  assert.equal(instance.playedTime, 0)
  assert.equal(instance.progressPercent, 0)
  assert.equal(instance.paused, false)
  assert.ok(Math.abs(current.currentTime) < TIME_EPSILON)
  assert.equal(current.src, 'a.mp4')
})

test('片尾重播：直接拖到末尾后再点播放也能重头开始', async () => {
  const instance = createInstance(LIST)
  setupDom()
  instance.seekTo(TOTAL, false)
  await flush()
  assert.equal(instance.endFlag, true)

  instance.changeVideoState()
  await flush()
  const current = document.getElementById('AutoVideoId')
  assert.equal(instance.playIndex, 0)
  assert.equal(instance.playedTime, 0)
  assert.equal(current.src, 'a.mp4')
})

test('跳转后预加载：从旧片段跳到别的片段，预加载起点按新片段重新计算', async () => {
  const instance = createInstance(LIST)
  // 第一次跳到第 1 段，此时应预加载第 2 段
  await runSeek(instance, 1, true)
  assert.equal(document.getElementById('preLoadVideoId').src, 'b.mp4')

  // 再跳到第 3 段（全局 12s 落在 [9, 17.92) 区间），
  // 预加载必须改成第 4 段，而不是沿用旧的 b.mp4
  setupDom()
  instance.dropInited = false
  instance.seekTo(12, true)
  await flush()
  const preload = document.getElementById('preLoadVideoId')
  preload.finishMetadata()
  await flush()
  assert.equal(instance.playIndex, 2)
  assert.equal(preload.src, 'd.mp4')
  assert.ok(Math.abs(preload.currentTime - 21.52) < TIME_EPSILON)
})

test('点击进度条：按 .bar 宽度换算时间，播放中跳转后继续播放', async () => {
  const instance = createInstance(LIST)
  setupDom()
  instance.dropInited = true
  instance.paused = false
  // 点击到 25% 处 -> 全局 5.28s -> 第 2 段，偏移 2.16
  instance.skipLine({ clientX: 100 })
  await flush()
  const current = document.getElementById('AutoVideoId')
  current.finishMetadata()
  await flush()
  current.finishSeek()
  await flush()

  assert.equal(instance.playIndex, 1)
  assert.ok(Math.abs(instance.playedTime - TOTAL * 0.25) < TIME_EPSILON)
  assert.ok(Math.abs(current.currentTime - (4.32 + (TOTAL * 0.25 - 3.12))) < TIME_EPSILON)
  assert.equal(instance.paused, false)
  assert.equal(current.playCalls, 1)
})

test('点击进度条：暂停状态下跳转后仍保持暂停', async () => {
  const instance = createInstance(LIST)
  setupDom()
  instance.paused = true
  instance.skipLine({ clientX: 300 })
  await flush()
  const current = document.getElementById('AutoVideoId')
  current.finishMetadata()
  await flush()
  current.finishSeek()
  await flush()

  assert.equal(instance.paused, true)
  assert.equal(current.playCalls, 0)
  assert.ok(Math.abs(instance.playedTime - TOTAL * 0.75) < TIME_EPSILON)
})

test('拖动进度条：松手后按拖动前的状态决定是否继续播放', async () => {
  const instance = createInstance(LIST)
  // 播放中拖动 -> 继续播放
  setupDom()
  instance.paused = false
  instance.videoObj = { played: true, paused: false, pause() {}, play() { return Promise.resolve() } }
  instance.drag = 1
  instance.dragWasPlaying = true
  instance.dragStartTime = instance.playedTime
  instance.mouseover({ clientX: 100 })
  instance.mouseup()
  await flush()
  assert.equal(instance.paused, false)

  // 暂停中拖动 -> 保持暂停
  const paused = createInstance(LIST)
  setupDom()
  paused.paused = true
  paused.videoObj = { played: false, paused: true, pause() {} }
  paused.drag = 1
  paused.dragWasPlaying = false
  paused.dragStartTime = paused.playedTime
  paused.mouseover({ clientX: 200 })
  const targetTime = paused.playedTime
  paused.mouseup()
  await flush()
  assert.equal(paused.paused, true)
  assert.ok(targetTime > 0)
  // 跳转仍然生效：进度条数值与跳转目标一致
  assert.ok(Math.abs(paused.playedTime - targetTime) < TIME_EPSILON)
})

test('预加载失败不影响主播放链路（同一视频源重复使用）', async () => {
  const same = LIST.map((item) => ({ ...item, url: 'a.mp4' }))
  const instance = createInstance(same)
  const { current, preload } = await runSeek(instance, 12, true)
  assert.equal(instance.playIndex, 2)
  assert.ok(Math.abs(current.currentTime - (11.4 + (12 - 9))) < TIME_EPSILON)
  assert.equal(preload.src, 'a.mp4')
  assert.ok(Math.abs(preload.currentTime - 21.52) < TIME_EPSILON)
})

test('同一视频源跳转：不重复给当前视频赋值 src，避免重新加载', async () => {
  const same = LIST.map((item) => ({ ...item, url: 'a.mp4' }))
  const instance = createInstance(same)
  await runSeek(instance, 1, true)
  setupDom()
  instance.dropInited = false
  instance.seekTo(5, true)
  await flush()
  const current = document.getElementById('AutoVideoId')
  const srcSetCount = current.srcSetCount
  current.finishMetadata()
  await flush()
  current.finishSeek()
  await flush()
  // 第二次创建的是同一个 DOM 节点，src 没有被重新赋值
  assert.equal(current.srcSetCount, srcSetCount)
})

test('暂停态跳转后立刻点播放：等定位完成才起播，不会从旧位置开始', async () => {
  const instance = createInstance(LIST)
  setupDom()
  instance.paused = true
  instance.seekTo(5, false)
  await flush()
  const current = document.getElementById('AutoVideoId')
  // 元数据还没就绪，此时点播放
  instance.changeVideoState()
  assert.equal(instance.paused, false, '界面应立刻显示为播放中')
  assert.equal(current.playCalls, 0, '定位完成前不能起播')

  current.finishMetadata()
  await flush()
  current.finishSeek()
  await flush()

  // 定位到段内偏移后才真正开始播放
  assert.ok(Math.abs(current.currentTime - 6.2) < TIME_EPSILON)
  assert.equal(current.playCalls, 1)
  assert.equal(instance.paused, false)
})

test('连续跳转：只保留最后一次跳转的位置', async () => {
  const instance = createInstance(LIST)
  setupDom()
  instance.seekTo(2, true)
  await flush()
  instance.seekTo(15, true)
  await flush()
  const current = document.getElementById('AutoVideoId')
  current.finishMetadata()
  await flush()
  current.finishSeek()
  await flush()

  assert.equal(instance.playIndex, 2)
  assert.ok(Math.abs(instance.playedTime - 15) < TIME_EPSILON)
  // 第三次段内偏移 = 15 - 9 = 6；c.mp4 起点 11.4 -> 17.4
  assert.ok(Math.abs(current.currentTime - (11.4 + 6)) < TIME_EPSILON)
})

test('播放中进度条随播放推进，且不会越过当前片段累计终点', async () => {
  const instance = createInstance(LIST)
  const total = 21.12
  instance.playedTime = 3
  instance.cacheCurrentTime = 4.32
  // 模拟第 2 段推进到接近本段末尾
  instance.playIndex = 1
  setupDom()
  instance.seekTo(8.99, true)
  await flush()
  const current = document.getElementById('AutoVideoId')
  current.finishMetadata()
  await flush()
  current.finishSeek()
  await flush()

  // 人为让 timeupdate 大幅越过本段累计终点
  current.currentTime = 12
  current.ontimeupdate()
  assert.ok(instance.playedTime <= instance.skipDict[1] + TIME_EPSILON)
  assert.ok(instance.playedTime <= total)
})

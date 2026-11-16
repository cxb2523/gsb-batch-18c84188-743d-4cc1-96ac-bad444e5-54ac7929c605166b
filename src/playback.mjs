/**
 * 混剪播放器的时间轴计算工具。
 *
 * 这些函数不依赖 Vue / DOM / Video，方便在 Node 里直接跑单元测试。
 * 时间轴坐标说明：
 *   - `playedTime` / `totalTime` 是“所有片段累计后”的全局时间
 *   - `skipDict` 是每一段累计终点（cumulativeEnds），用于把全局时间映射回片段
 */

// 浮点时间比较的容差（秒）。片段边界在播放器里都是 parseFloat 得到的，
// 直接用 === 比较并不可靠，这里统一使用一个远小于一帧的容差。
export const TIME_EPSILON = 1e-6

function toFiniteNumber(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 把原始 playPoint 配置解析成数字区间，并保证 end >= start >= 0。
 * @param {Array} list 形如 [{ playPoint: { start: '0', end: '3.12' } }]
 * @returns {Array<{start:number,end:number,duration:number}>}
 */
export function normalizePlaylist(list) {
  if (!Array.isArray(list)) return []
  return list.map((item) => {
    const playPoint = (item && item.playPoint) || {}
    const rawStart = toFiniteNumber(playPoint.start, 0)
    const rawEnd = toFiniteNumber(playPoint.end, rawStart)
    const start = rawStart >= 0 ? rawStart : 0
    const end = rawEnd >= start ? rawEnd : start
    return { start, end, duration: end - start }
  })
}

/**
 * 计算总时长与每段累计终点。
 * @returns {{totalTime:number, cumulativeEnds:number[]}}
 */
export function buildTimeline(segments) {
  let totalTime = 0
  const cumulativeEnds = []
  for (const segment of segments || []) {
    totalTime += Math.max(0, segment.end - segment.start)
    cumulativeEnds.push(totalTime)
  }
  return { totalTime, cumulativeEnds }
}

/**
 * 把全局播放时间解析成“第几段 + 段内偏移”。
 *
 * 边界约定（确定行为，不会产出不存在的片段下标）：
 *   - time <= 0                -> 第 1 段开头（offset 0）
 *   - 恰好等于某段累计终点       -> 下一段开头（offset 0）
 *   - 恰好等于/超过总时长        -> 最后一段末尾（atEnd: true，停住不播放）
 *   - 时间轴为空               -> index 0 / atEnd: true
 *
 * @param {number[]} cumulativeEnds 每段的累计终点
 * @param {number} totalTime 所有片段总时长
 * @param {number} time 目标全局时间
 * @returns {{index:number, offset:number, playedTime:number, atEnd:boolean}}
 */
export function resolveSeekTarget(cumulativeEnds, totalTime, time) {
  const count = Array.isArray(cumulativeEnds) ? cumulativeEnds.length : 0
  if (!count) {
    return { index: 0, offset: 0, playedTime: 0, atEnd: true }
  }

  const safeTotal = Math.max(0, toFiniteNumber(totalTime, 0))
  let target = toFiniteNumber(time, 0)
  if (target < 0) target = 0
  if (target > safeTotal) target = safeTotal

  // 最后一段末尾：停在最后一帧，不越界到不存在的片段。
  // 时长为 0 的片段没有可播放的画面，末尾应回落到最后一个有效片段。
  if (target >= safeTotal - TIME_EPSILON) {
    let index = count - 1
    while (index > 0 && cumulativeEnds[index] - cumulativeEnds[index - 1] <= TIME_EPSILON) {
      index--
    }
    const segmentStart = index === 0 ? 0 : cumulativeEnds[index - 1]
    return {
      index,
      offset: Math.max(0, cumulativeEnds[index] - segmentStart),
      playedTime: safeTotal,
      atEnd: true,
    }
  }

  // 找到第一个“累计终点严格大于目标时间”的片段。
  // 由于判定为 `target < cumulativeEnd - EPS`，恰好落在累计终点时自然归入下一段。
  let index = count - 1
  for (let i = 0; i < count - 1; i++) {
    if (target < cumulativeEnds[i] - TIME_EPSILON) {
      index = i
      break
    }
  }

  const segmentStart = index === 0 ? 0 : cumulativeEnds[index - 1]
  const segmentDuration = Math.max(0, cumulativeEnds[index] - segmentStart)
  let offset = target - segmentStart
  if (offset < 0) offset = 0
  if (offset > segmentDuration) offset = segmentDuration

  return {
    index,
    offset,
    playedTime: segmentStart + offset,
    atEnd: false,
  }
}

/**
 * 计算某段的播放参数，以及下一段预加载的起点。
 * 跳转后当前段、下一段的起点都会随 index / offset 重新计算，避免沿用旧片段。
 *
 * @param {Array<{start:number,end:number}>} segments 规整后的片段
 * @param {number} index 目标片段下标
 * @param {number} offset 段内偏移（秒）
 * @returns {null|{index:number, offset:number, startTime:number, endTime:number,
 *                nextIndex:number, nextStartTime:number, nextEndTime:number}}
 */
export function getPlaybackTarget(segments, index, offset) {
  if (!Array.isArray(segments) || segments.length === 0) return null
  const safeIndex = Math.min(Math.max(Math.trunc(toFiniteNumber(index, 0)), 0), segments.length - 1)
  const segment = segments[safeIndex]
  const duration = Math.max(0, segment.end - segment.start)
  let safeOffset = toFiniteNumber(offset, 0)
  if (safeOffset < 0) safeOffset = 0
  if (safeOffset > duration) safeOffset = duration

  const nextIndex = (safeIndex + 1) % segments.length
  const nextSegment = segments[nextIndex]

  return {
    index: safeIndex,
    offset: safeOffset,
    startTime: segment.start + safeOffset,
    endTime: segment.end,
    nextIndex,
    nextStartTime: nextSegment.start,
    nextEndTime: nextSegment.end,
  }
}

/**
 * 当前段播完后推进到下一段；最后一段播完则进入结束状态。
 * 结束状态下 index 会被置为片段数量（旧逻辑依赖这个值判断是否重播）。
 */
export function advancePlayback(cumulativeEnds, totalTime, currentIndex) {
  const count = Array.isArray(cumulativeEnds) ? cumulativeEnds.length : 0
  if (!count) {
    return { index: 0, playedTime: 0, ended: true, paused: true }
  }
  const nextIndex = toFiniteNumber(currentIndex, 0) + 1
  if (nextIndex >= count) {
    return {
      index: count,
      playedTime: Math.max(0, toFiniteNumber(totalTime, 0)),
      ended: true,
      paused: true,
    }
  }
  return {
    index: nextIndex,
    // 对齐到下一段的累计起点，避免 timeupdate 累计误差造成进度条漂移。
    playedTime: cumulativeEnds[nextIndex - 1],
    ended: false,
    paused: false,
  }
}

/**
 * 片尾重播 / 首次播放的起始状态：第一段开头、进度归零、清除结束标记。
 */
export function restartPlayback() {
  return { index: 0, playedTime: 0, ended: false, paused: false }
}

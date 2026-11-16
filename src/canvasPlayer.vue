<template>
  <div class="popup-layer">
    <div class="video-player-wrapper">
      <div id="VideoDom">
        <div id="canvasDom">
          <div v-show="showDom" id="progressBar" :class="[paused ? 'show' : '']">
            <div class="bar" @click.stop="skipLine">
              <div
                ref="trunk"
                class="line"
                :class="['progress', paused ? 'pause' : 'play', !drag ? 'trans' : '']"
                :style="{ width: `${progressPercent}%` }"
              ></div>
              <div id="circle" :class="{ trans: !drag }"></div>
            </div>

            <div class="left-box">
              <div href="#" class="btn">
                <button
                  class="play"
                  :class="[paused ? 'play' : 'pause']"
                  @click="changeVideoState"
                ></button>
              </div>
              <div class="total-time">{{ sToHs(playedTime) }} / {{ sToHs(totalTime) }}</div>
            </div>
            <div class="volume">
              <input type="checkbox" @click="changeVoiceStatus" />
              <svg viewBox="0 0 108 96">
                <path
                  d="M7,28 L35,28 L35,28 L59,8 L59,88 L35,68 L7,68 C4.790861,68 3,66.209139 3,64 L3,32 C3,29.790861 4.790861,28 7,28 Z"
                ></path>
                <path
                  d="M79,62 C83,57.3333333 85,52.6666667 85,48 C85,43.3333333 83,38.6666667 79,34 L49,3"
                ></path>
                <path
                  d="M95,69 C101.666667,61.6666667 105,54.3333333 105,47 C105,39.6666667 101.666667,32.3333333 95,25 L75.5,6 L49,33"
                ></path>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
    <i class="popup-layer-btn-close" @click="close">x</i>
    <div v-show="!showDom" class="loadEffect">
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
    </div>
    <section v-show="paused" class="playContainer" @click="changeVideoState">
      <li class="playBtn">
        <a href="#" title="start">Start</a>
      </li>
    </section>
  </div>
</template>

<script setup>
import {
  TIME_EPSILON,
  normalizePlaylist,
  buildTimeline,
  resolveSeekTarget,
  getPlaybackTarget,
  advancePlayback,
  restartPlayback,
} from './playback.mjs'

export default {
  data() {
    return {
      list: [],
      playerlist: [],
      // new add ===
      playIndex: 0,
      RAFCancelReq: null,
      logo: '',
      videoList: [],
      // 当前播放对象
      videoObj: {},
      // 是否暂停
      paused: true,
      // 总时长
      totalTime: 0,
      // 当前播放时长
      playedTime: 0,
      // 缓存进度条时间
      cacheCurrentTime: 0,
      endFlag: false,
      // 动态增减
      activeLength: 0,
      // 时间段节点记录,进度条快速定位
      skipDict: [],
      // 是否展示进度条
      showDom: false,
      // 是否已经绑定事件
      drag: 0,
      // 拖动前是否处于播放状态（松手后据此决定是否继续播放）
      dragWasPlaying: false,
      // 拖动开始时的全局时间，用于判断是否真的拖动过
      dragStartTime: 0,
      // 拖动结束后浏览器还会补发一次 click，需要忽略，避免重复跳转
      suppressClick: false,
      // 播放代次：每次重建播放链路自增，用于丢弃上一段遗留的回调
      playToken: 0,
      // 尚未完成定位的播放链路代次；等于 playToken 时表示正在 seek
      pendingPlayToken: -1,
      // seek 期间用户的播放/暂停意图；null 表示沿用跳转时传入的 autoPlay
      seekPlayIntent: null,
      // 进度条拖拽事件是否已经绑定，避免每次播放重复绑定
      dropInited: false,
    }
  },
  computed: {
    // 进度条百分比：播放进度永远不会超出 [0, 100]
    progressPercent() {
      if (!Number.isFinite(this.totalTime) || this.totalTime <= 0) return 0
      const percent = (this.playedTime / this.totalTime) * 100
      if (!Number.isFinite(percent)) return 0
      return Math.min(Math.max(percent, 0), 100)
    },
  },
  beforeDestroy() {
    if (typeof this.setFree === 'function') {
      this.setFree()
    }
    console.log('desotory')
    document.removeEventListener('keydown', this.keydown)
    document.removeEventListener('mousemove', this.mouseover)
    document.removeEventListener('mouseup', this.mouseup)
    const canvas = document.querySelector('#AutoCanvasId')
    if (canvas) {
      canvas.removeEventListener('click', this.changeVideoState)
    }
  },
  mounted() {
    let _self = this
    this.init()
    // 统一把 playPoint 解析成数字区间，后续时间轴计算只认这份数据
    _self.playerlist = normalizePlaylist(_self.list)
    _self.videoList = _self.list
    _self.comTotalTime()
    document.addEventListener('keydown', _self.keydown)
    _self.$nextTick(() => {
      _self.gotoPlay()
    })
  },

  methods: {
    initDrop2() {
      let _self = this
      _self.drag = 0
      // 事件只绑定一次，避免每次 playback 重建都重复叠加
      if (_self.dropInited) return
      _self.dropInited = true
      let dropBtn = document.querySelector('#circle')
      //进度按钮被点击
      if (dropBtn) {
        dropBtn.addEventListener('mousedown', function() {
          _self.drag = 1
          _self.dragStartTime = _self.playedTime
          // 记录拖动前的播放状态，松手后据此恢复/保持暂停
          _self.dragWasPlaying =
            !_self.paused && !!_self.videoObj && _self.videoObj.paused === false
          if (_self.dragWasPlaying) {
            _self.videoObj.pause()
            _self.paused = true
          }
        })
      }
      //页面被释放
      document.addEventListener('mouseup', _self.mouseup)
      // //拖动事件
      document.addEventListener('mousemove', _self.mouseover)
      // AutoCanvasId
      const canvas = document.querySelector('#AutoCanvasId')
      if (canvas) {
        canvas.addEventListener('click', _self.changeVideoState)
      }
    },
    // 进度条上的鼠标位置 -> 全局时间，带边界钳制
    getTimeByPointer(touch) {
      let progress = document.querySelector('.bar')
      if (!progress) return this.playedTime
      let rect = progress.getBoundingClientRect()
      let offsetX = touch.clientX - rect.left
      if (offsetX < 0) {
        offsetX = 0
      } else if (offsetX > rect.width) {
        offsetX = rect.width
      }
      let percent = rect.width > 0 ? offsetX / rect.width : 0
      let rate = percent * this.totalTime
      if (rate < 0) rate = 0
      if (rate > this.totalTime) rate = this.totalTime
      return rate
    },
    setValue(touch) {
      //拖动实时改变进度条
      this.playedTime = this.getTimeByPointer(touch)
    },
    mouseup() {
      let _self = this
      if (_self.drag === 1) {
        const moved = Math.abs(_self.playedTime - _self.dragStartTime) > TIME_EPSILON
        if (moved) {
          // 拖动前正在播放 -> 跳转后继续播放；原本暂停 -> 保持暂停。
          // 拖动过程中进度条已实时更新，这里不再回写，避免闪动。
          _self.skipProgress(_self.dragWasPlaying)
        } else if (_self.dragWasPlaying && _self.videoObj && _self.videoObj.play) {
          // 只是在滑块上按下又松开、没有移动：恢复原播放状态，不必重建播放链路
          let playPromise = _self.videoObj.play()
          if (playPromise !== undefined && playPromise.catch) {
            playPromise.catch(() => {})
          }
          _self.paused = false
        }
        // 拖拽结束后浏览器会紧接着补发一次 click 到进度条：
        // 标记为忽略，并在本次事件序列结束后复位，避免吞掉后续真实点击。
        _self.suppressClick = true
        setTimeout(() => {
          _self.suppressClick = false
        }, 0)
      }
      this.drag = 0
    },
    mouseover(e) {
      let _self = this
      if (_self.drag === 1) {
        _self.setValue(e)
      }
    },
    // 快进跳转（拖动结束后触发）
    skipProgress(shouldPlay) {
      let autoPlay = typeof shouldPlay === 'boolean' ? shouldPlay : !this.paused
      this.seekTo(this.playedTime, autoPlay)
    },
    /**
     * 把全局进度定位到目标时间：
     * 1. 用累计终点判断落在第几段；
     * 2. 计算段内偏移并交给播放逻辑；
     * 3. 暂停状态下保持暂停。
     *
     * @param {number} time 目标全局时间（秒）
     * @param {boolean} autoPlay 定位完成后是否播放
     */
    seekTo(time, autoPlay) {
      let target = resolveSeekTarget(this.skipDict, this.totalTime, time)
      this.drag = 0
      // 跳转前先清空结束标记；片尾跳转后会重新置为 true
      this.endFlag = false
      this.playIndex = target.index
      this.playedTime = target.playedTime

      if (target.atEnd) {
        // 时间轴末尾：停在最后一段的最后一帧，标记结束，等待重播。
        // 不越界创建不存在的片段，也不会自动开始播放。
        // 定位点回退半帧，保证浏览器能取到可绘制的最后一帧而不是空帧。
        let lastOffset = target.offset
        let lastDuration = this.playerlist[target.index]
          ? this.playerlist[target.index].duration
          : 0
        if (lastDuration > 0.04) {
          lastOffset = Math.max(0, Math.min(lastOffset, lastDuration) - 0.04)
        }
        this.paused = true
        this.endFlag = true
        // 进度显示到总时长末尾，但画面停在可绘制的最后一帧
        this.VideoPlay(lastOffset, false, target.playedTime)
        return
      }

      this.paused = !autoPlay
      this.VideoPlay(target.offset, autoPlay)
    },
    // 点击快进跳转
    skipLine(e) {
      // 拖动松手后浏览器补发的 click 直接忽略
      if (this.suppressClick) {
        e && e.preventDefault && e.preventDefault()
        return
      }
      let rate = this.getTimeByPointer(e)
      // 点击进度条：原本暂停则跳转后仍暂停
      this.seekTo(rate, !this.paused)
    },
    init() {
      this.RAF()
      this.playedTime = 0
    },
    resetVideo() {
      if (this.videoObj && !this.videoObj.paused) {
        this.videoObj.pause()
        this.paused = true
        this.playIndex = 0
      }
    },
    RAF(cb) {
      return window.requestAnimationFrame(() => {
        window.setTimeout(cb, 1000 / 60)
      })
    },
    // 取消当前绘制循环
    pauseDraw() {
      if (this.RAFCancelReq) {
        window.cancelAnimationFrame(this.RAFCancelReq)
        this.RAFCancelReq = null
      }
    },
    // 计算总时长
    comTotalTime() {
      let timeline = buildTimeline(this.playerlist)
      this.skipDict = timeline.cumulativeEnds
      this.totalTime = timeline.totalTime
    },
    close() {
      let _self = this
      try {
        if (typeof _self.onClose === 'function') {
          _self.onClose(_self)
        }
        setTimeout(() => {
          _self.$destroy(true)
          _self.$el.parentNode.removeChild(_self.$el)
        }, 200)
      } catch (e) {
        console.log(e)
      }
    },
    keydown(e) {
      let _self = this
      if (e.keyCode === 27) {
        // esc关闭消息
        _self.close()
      }
    },
    // add 播放器核心方法
    async gotoPlay() {
      let _self = this
      // 从头开始：第一段开头、进度归零、清除结束标记
      let state = restartPlayback()
      _self.playIndex = state.index
      _self.playedTime = state.playedTime
      _self.paused = state.paused
      _self.endFlag = state.ended
      _self.cacheCurrentTime = 0
      _self.VideoPlay(0, true)
    },
    // 截获当前视频播放器
    updateCurrentVideo(videoObj) {
      this.videoObj = videoObj
    },
    // 播放 || 暂停
    changeVideoState() {
      let _self = this
      // 已结束（片尾）再次触发播放：从第一段开头重播，而不是沿用旧的播放进度
      if (_self.endFlag || _self.playIndex >= _self.playerlist.length) {
        _self.playedTime = 0
        _self.gotoPlay()
        return
      }
      if (!_self.videoObj || !_self.videoObj.play) {
        _self.gotoPlay()
        return
      }
      if (_self.pendingPlayToken === _self.playToken) {
        // 跳转定位还没完成：只记录播放意图，等定位到目标位置后再切换，
        // 避免在旧位置起播造成画面/进度不一致
        let wantPlay = !!_self.paused
        _self.seekPlayIntent = wantPlay
        _self.paused = !wantPlay
        return
      }
      if (_self.paused) {
        let playPromise = _self.videoObj.play()
        if (playPromise !== undefined) {
          playPromise.catch((error) => {
            console.log('sorry! 视频播放失败', error)
          })
        }
        _self.paused = false
      } else {
        _self.videoObj.pause()
        _self.paused = true
      }
    },
    // 静音
    changeVoiceStatus() {
      if (this.videoObj) {
        this.videoObj.muted = !this.videoObj.muted
      }
    },
    /**
     * 核心启动逻辑。
     * @param {number} shortSliceTime 段内偏移（秒），由全局时间换算而来
     * @param {boolean} autoPlay 定位后是否自动播放；false 表示保持暂停
     * @param {number} [progressTime] 进度条应显示的全局时间；缺省由片段+偏移换算
     */
    async VideoPlay(shortSliceTime = 0, autoPlay = true, progressTime) {
      let _self = this
      let targets = getPlaybackTarget(_self.playerlist, _self.playIndex, shortSliceTime)
      if (!targets) {
        return
      }
      // 每次重建播放链路都换一个代次，旧链路遗留的回调直接丢弃
      let token = ++_self.playToken
      // 在新链路真正定位到目标之前，都标记为 seek 中，
      // 这样切到新片段后暂停/播放按钮不会在旧位置误起播
      _self.pendingPlayToken = token
      _self.seekPlayIntent = null
      // 立即停掉旧片段的播放与绘制，防止跳转过程中进度条继续累加
      _self.pauseDraw()
      if (_self.videoObj && _self.videoObj.pause) {
        _self.videoObj.pause()
      }

      // console.log("_self.playIndex: " + _self.playIndex);
      // 准备工作start
      let elDom = document.querySelector('#VideoDom')
      let canvasDom = document.querySelector('#canvasDom')
      // 一、解析当前视频的各个参数 视频信息：1.当前播放路径、2.播放开始时间、3.播放结束时间、4.下部视频下标
      let currentVideo = _self.videoList[targets.index]
      let currentUrl = currentVideo.url
      // 当前段从“片段起点 + 段内偏移”开始，结束点仍是该段配置的 end
      let currentStartTime = targets.startTime
      let currentEndTime = targets.endTime
      // logo信息
      let currentLogoInfo = {
        logo: _self.logo,
        position: currentVideo.logoPosition,
        videoWidth: currentVideo.width,
      }
      // 二、下一段（最后一段之后回到第一段，用于预加载）
      let nextIndex = targets.nextIndex

      // 进度条回到准确的目标位置，避免播放回调累加造成偏差
      _self.playIndex = targets.index
      _self.cacheCurrentTime = currentStartTime
      _self.playedTime = Number.isFinite(progressTime)
        ? progressTime
        : _self.getGlobalTime(targets.index, targets.offset)

      //创建
      // 创建两部视频的Dom节点
      let videoObj = await _self.createVideo(elDom, 'AutoVideoId')
      let nextVideoObj = await _self.createVideo(elDom, 'preLoadVideoId', true)
      // 创建canvas的Dom节点
      let CanvasEle = await _self.createCanvas(canvasDom, 'AutoCanvasId') //document.getElementById('AutoCanvasId')
      let context = CanvasEle.getContext('2d')
      if (token !== _self.playToken) return

      // 当前段进度对应的全局终点，用于钳制播放进度不越过本段
      const segmentGlobalEnd = _self.skipDict[targets.index]

      let started = false
      let isSeeking = false

      const setupCanvas = () => {
        CanvasEle.width = videoObj.width
        CanvasEle.height = videoObj.height
        _self.showDom = true
      }

      // 定位完成后的统一入口：按 autoPlay 决定播放还是停在目标帧
      const beginAtTarget = () => {
        if (token !== _self.playToken || started) return
        started = true
        isSeeking = false
        _self.pendingPlayToken = -1
        _self.cacheCurrentTime = videoObj.currentTime
        setupCanvas()
        // seek 期间用户点过按钮时以其意图为准
        let shouldPlay = _self.seekPlayIntent === null ? !!autoPlay : _self.seekPlayIntent
        _self.seekPlayIntent = null
        if (!shouldPlay) {
          // 暂停态跳转：停在目标帧，不自动播放
          _self.paused = true
          _self.drawCurrentFrame(videoObj, context)
          return
        }
        _self.paused = false
        videoObj.volume = 1
        let playPromise = videoObj.play()
        if (playPromise !== undefined && playPromise.then) {
          playPromise
            .then(() => {
              if (token !== _self.playToken) return
              _self.initDrop2()
            })
            .catch((error) => {
              console.log('sorry! 视频初始化失败', error)
            })
        }
      }

      // 把视频定位到目标起点；元数据未就绪时等 loadedmetadata 再定位
      const applyStartSeek = () => {
        if (token !== _self.playToken || started) return
        if (videoObj.readyState < 1) return
        isSeeking = true
        _self.pendingPlayToken = token
        try {
          videoObj.currentTime = currentStartTime
        } catch (e) {
          console.log('sorry! 视频定位失败', e)
        }
        _self.cacheCurrentTime = currentStartTime
        // 目标位置和当前位置一致时浏览器不会派发 seeked，这里补一次兜底。
        // 只有确认本次 seek 已经结束、数据可绘制、并且确实停在目标位置时才起播，
        // 避免在换源后的旧位置（例如 0s）提前出帧。
        setTimeout(() => {
          if (token !== _self.playToken || started) return
          if (videoObj.seeking) return
          if (videoObj.readyState < 2) return
          if (Math.abs(videoObj.currentTime - currentStartTime) > 0.05) return
          beginAtTarget()
        }, 32)
      }

      // 记录本次真正设置的视频源：只有源没变时才能直接立即 seek，
      // 否则要等新源的元数据就绪，避免在旧时长上定位导致画面错位。
      const previousSrc = videoObj.__playerSrc
      videoObj.__playerSrc = currentUrl
      const sameSource = previousSrc === currentUrl
      // 重新定位前先停掉旧位置上的播放，避免旧画面继续推进
      if (videoObj.pause) {
        videoObj.pause()
      }
      // 同一视频源时不重新赋值 src，保留已缓冲的数据，减少跳转黑屏
      if (!sameSource) {
        videoObj.src = currentUrl
      }
      // 更新视频对象
      _self.updateCurrentVideo(videoObj)
      videoObj.onloadedmetadata = function() {
        if (token !== _self.playToken) return
        _self.setVideoStyle(videoObj)
        applyStartSeek()
      }
      //视频源改变时，指定开始播放时间
      videoObj.ondurationchange = function() {
        if (token !== _self.playToken) return
        applyStartSeek()
      }
      //重新定位播放位置
      videoObj.onseeked = function() {
        if (token !== _self.playToken) return
        // 只认我们自己发起的定位：换源时浏览器可能先在 0s 处派发一次 seeked，
        // 提前起播会让画面从错误位置开始
        if (!isSeeking) return
        beginAtTarget()
      }
      //播放位置改变
      videoObj.ontimeupdate = function() {
        if (token !== _self.playToken || isSeeking) return
        let updateTime = videoObj.currentTime - _self.cacheCurrentTime
        if (updateTime < 0) {
          // 发生回退（seek）时只重新对齐缓存，不污染总进度
          _self.cacheCurrentTime = videoObj.currentTime
        } else {
          let nextPlayed = _self.playedTime + updateTime
          // 本段进度不能越过该段的累计终点
          if (nextPlayed > segmentGlobalEnd) nextPlayed = segmentGlobalEnd
          _self.playedTime = Math.min(nextPlayed, _self.totalTime)
          _self.cacheCurrentTime = videoObj.currentTime
        }
        if (videoObj.currentTime >= currentEndTime - TIME_EPSILON) {
          _self.playNext(videoObj, token)
        }
      }
      // 视频源本身提前播完（配置的 end 超出实际时长）时同样推进到下一段
      videoObj.onended = function() {
        if (token !== _self.playToken) return
        _self.playNext(videoObj, token)
      }

      //开始播放
      videoObj.onplay = function() {
        if (token !== _self.playToken) return
        // console.log("onplay");
        setupCanvas()
        _self.pauseDraw()
        _self.RAFCancelReq = _self.RAF(drawData)
        // 创建logo
        _self.createAndPutLogo(canvasDom, 'logoId', currentLogoInfo)
        // 展示进度条
        _self.showDom = true
      }

      //预加载视频
      _self.preloadVideo(nextVideoObj, _self.videoList[nextIndex], targets.nextStartTime, token)

      //取消轮询
      let cancelAnimationFrame = function(flag) {
        window.cancelAnimationFrame(flag)
      }

      function drawData() {
        if (token !== _self.playToken) return
        if (
          videoObj.ended ||
          videoObj.paused ||
          videoObj.currentTime < currentStartTime - TIME_EPSILON ||
          videoObj.currentTime >= currentEndTime
        ) {
          // console.log("videoObj.paused", videoObj.paused);
          cancelAnimationFrame(_self.RAFCancelReq)
          videoObj.pause()
          return
        }
        context.drawImage(videoObj, 0, 0, videoObj.width, videoObj.height)
        _self.RAFCancelReq = _self.RAF(drawData)
      }

      // 元数据已经就绪（例如同一视频源重复使用）时立即定位；
      // 换了新源时等 loadedmetadata / durationchange 再定位
      if (sameSource && videoObj.readyState >= 1) {
        applyStartSeek()
      }
      // 进度条拖拽事件只绑定一次
      _self.$nextTick(() => {
        _self.initDrop2()
      })
    },
    // 预加载下一段：起点按目标片段重新计算
    preloadVideo(nextVideoObj, nextVideo, nextStartTime, token) {
      let _self = this
      if (!nextVideoObj || !nextVideo) return
      const startTime = Number.isFinite(nextStartTime)
        ? nextStartTime
        : parseFloat(nextVideo.playPoint.start)
      const applyNextSeek = () => {
        if (token !== _self.playToken) return
        if (nextVideoObj.readyState < 1) return
        if (Math.abs(nextVideoObj.currentTime - startTime) < TIME_EPSILON) return
        try {
          nextVideoObj.currentTime = startTime
        } catch (e) {
          // 忽略预加载定位失败，不影响主播放链路
        }
      }
      nextVideoObj.onloadedmetadata = function() {
        if (token !== _self.playToken) return
        _self.setVideoStyle(nextVideoObj)
        applyNextSeek()
      }
      nextVideoObj.ondurationchange = applyNextSeek
      // 源没变时不要重复赋值，避免重新下载与衔接处黑屏
      if (nextVideoObj.__preloadSrc !== nextVideo.url) {
        nextVideoObj.__preloadSrc = nextVideo.url
        nextVideoObj.src = nextVideo.url
      }
      applyNextSeek()
    },
    // 把当前全局进度换算成该段的起点
    getGlobalTime(index, offset) {
      let base = index === 0 ? 0 : this.skipDict[index - 1]
      if (!Number.isFinite(base)) base = 0
      return Math.min(Math.max(base + (offset || 0), 0), this.totalTime)
    },
    // 暂停状态下把指定视频的当前帧绘制到画布
    drawCurrentFrame(videoObj, context) {
      if (!videoObj || !context) return
      if (!videoObj.videoWidth) return
      context.drawImage(videoObj, 0, 0, videoObj.width, videoObj.height)
    },
    // 创建并摆放logo
    createAndPutLogo(parentDom, domId, logoInfo) {
      this.$nextTick(() => {
        let canvasDom = document.querySelector('#AutoCanvasId')
        parentDom = parentDom || document.body
        let obj = document.getElementById(domId)
        if (!obj) {
          obj = document.createElement('img')
          obj.id = domId
          parentDom.appendChild(obj)
        }
        obj.style = {}
        obj.style.display = 'none'
        obj.style.width = `${(canvasDom.width * 150) / 1080}px`
        obj.style.position = 'absolute'
        obj.style[logoInfo.position.x] = `${(canvasDom.width / 1080) * 60}px`
        obj.style[logoInfo.position.y] = `${(canvasDom.width / 1080) * 60}px`
        obj.src = logoInfo.logo
        this.$nextTick(() => {
          obj.style.display = 'block'
        }, 10000)
      })
    },
    //根据父容器大小设置视频尺寸
    setVideoStyle(vObj) {
      let parentWidth = vObj.parentNode.getBoundingClientRect().width
      let parentHeight = vObj.parentNode.getBoundingClientRect().height
      //根据父容器宽高计算 视频缩放比例
      let scaleVal = Math.max(vObj.videoWidth / parentWidth, vObj.videoHeight / parentHeight)
      let scaleWidth = vObj.videoWidth / scaleVal
      let scaleHeight = vObj.videoHeight / scaleVal
      vObj.width = scaleWidth
      vObj.height = scaleHeight
    },

    //创建视频对象
    createVideo(parentDom, domId, isMuted = false) {
      let _self = this
      if (!domId) {
        console.warn('缺少命名ID')
        return
      }
      parentDom = parentDom || document.body
      let obj = document.getElementById(domId)
      if (!obj) {
        obj = document.createElement('Video')
        obj.id = domId
        parentDom.appendChild(obj)
        let videoSize = parseInt(document.getElementsByTagName('video').length)
        //设置视频属性
        obj.preload = 'auto'
        obj.style = 'background:#000000;display:none;position:absolute;left:100%;top:0;'
        // 播放由 play() 显式控制：不能用 autoplay，否则暂停态跳转会被自动起播打断
        obj.autoplay = false
        obj.style.left = videoSize * 100 + '%'
        obj.controls = true
        obj.muted = isMuted
        obj.volume = 0.1
        //视频加载meta信息后，把自身尺寸修改了
        obj.onloadedmetadata = function() {
          // console.log('onloadedmetadata')
          _self.setVideoStyle(obj)
        }
      }
      return obj
    },
    //创建 Canvas对象
    createCanvas(parentDom, domId) {
      if (!domId) {
        console.warn('缺少命名ID')
        return
      }
      parentDom = parentDom || document.body
      let Obj = document.getElementById(domId)
      if (!Obj) {
        Obj = document.createElement('Canvas')
        Obj.id = domId
        parentDom.appendChild(Obj)
      }
      return Obj
    },

    // 播放下一曲
    playNext(curVideo, token) {
      let _self = this
      // 只接受当前播放链路发出的“播完”事件，避免旧片段的回调把新跳转顶掉
      if (token !== undefined && token !== _self.playToken) return
      // 已经处于结束态时不再重复推进
      if (_self.endFlag) return
      if (curVideo && curVideo.pause) {
        curVideo.pause()
      }
      _self.pauseDraw()
      let state = advancePlayback(_self.skipDict, _self.totalTime, _self.playIndex)
      if (state.ended) {
        // 全部片段播完：进度停在末尾，清除当前视频对象，等待重播
        _self.playIndex = state.index
        _self.playedTime = state.playedTime
        _self.paused = state.paused
        _self.endFlag = state.ended
        return
      }
      _self.playIndex = state.index
      // 对齐到下一段累计起点，避免累计误差造成进度条漂移
      _self.playedTime = state.playedTime
      _self.paused = state.paused
      _self.endFlag = state.ended
      _self.VideoPlay(0, true)
    },
    sToHs(s) {
      //计算分钟
      //算法：将秒数除以60，然后下舍入，既得到分钟数
      s = parseFloat(s).toFixed(0)
      var h
      h = Math.floor(s / 60)
      //计算秒
      //算法：取得秒%60的余数，既得到秒数
      s = s % 60
      //将变量转换为字符串
      h += ''
      s += ''
      //如果只有一位数，前面增加一个0
      h = h.length == 1 ? '0' + h : h
      s = s.length == 1 ? '0' + s : s
      return h + ':' + s
    },
  },
}
</script>
<style>
@import './style/style.css';
</style>
<style lang="less" scoped>
.popup-layer {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.85);
  color: #fff;

  .video-player-wrapper {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .popup-layer-btn-close {
    position: absolute;
    right: 20px;
    top: 20px;
    width: 50px;
    color: rgba(255, 255, 255, 0.8);
    text-align: center;
    font-style: initial;
    font-size: 40px;
    line-height: 30px;
    cursor: pointer;
    padding: 6px 0 12px;
    border-radius: 100%;
    user-select: none;
    &:hover {
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 1);
    }
  }
}

#VideoDom {
  position: relative;
  font-size: 0;
  line-height: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  #canvasDom {
    position: relative;
    #progressBar {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      bottom: 0;
      width: 100%;
      background: rgba(0, 0, 0, 0.521);
      z-index: 99;
      opacity: 0;
      transition: all 0.5s;
      .left-box {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        width: 50%;
        .btn {
          height: 100%;
          color: #000;
          margin-right: 2px;
          background: transparent;
          border: none;
          button {
            margin: 10px;
            padding: 0;
            box-sizing: border-box;
            border: transparent;
            background: transparent;
            user-select: none;
            &.play {
              height: 20px;
              border-style: solid;
              outline: none;
              border-width: 10px 0 10px 18px;
              border-color: transparent transparent transparent #00a1d6;
              transition: all 0.1s linear;
            }
            &.pause {
              border-style: double;
              border-width: 0px 0px 0px 18px;
              border-color: #00a1d6;
            }
          }
        }
        .total-time {
          color: #e3e3e3;
          font-size: 15px;
          line-height: 100%;
          pointer-events: none;
          user-select: none;
        }
      }

      .bar {
        display: flex;
        align-items: center;
        margin: 10px auto 0;
        width: 98%;
        height: 7px;
        border-radius: 10px;
        background: #7171716e;
        transition: all 0.2s;
        cursor: pointer;
        .line {
          position: relative;
          width: 100%;
          height: 100%;
          background: #00a1d6;
          border-radius: 5px;
          animation-timing-function: linear;
          &.trans {
            transition: all 0.5s;
          }
          &.play {
            animation-play-state: running;
          }
          &.pause {
            animation-play-state: paused;
          }
        }
        #circle {
          position: relative;
          margin-left: -4px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #fff;
          pointer-events: none;
          &.trans {
            pointer-events: auto;
            transition: all 0.5s;
          }
        }
      }

      &:hover {
        .bar {
          height: 13px;
          transition: all 0.2s;
          #circle {
            height: 14px;
            width: 14px;
          }
        }
      }
      &.show {
        opacity: 1;
      }
    }
    &:hover {
      #progressBar {
        opacity: 1;
        transition: all 1s;
      }
    }
  }
}
</style>

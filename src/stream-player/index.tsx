/**
 * 实时播放器
 * MediaSource
 */
import WebSocketProxy from './WebSocketProxy'

export type BinaryType = 'arraybuffer' | 'blob'
export type AppendMode = 'segments' | 'sequence'
export type BufferSource = ArrayBufferView | ArrayBuffer

export interface RealplayOptions {
  // videoMimeCodec: string; // 视频格式 + 视频编解码
  binaryType: BinaryType // websocket传输的二进制数据类型
  bufferMode: AppendMode // 控制媒体段播放顺序。segments: 按照媒体片段时间戳  sequence：按片段添加到 SourceBuffer的顺序
  onWsOpen: () => void // ws建立连接时触发
  onWsClose: () => void // ws断开时触发
  onWsReconnect: () => void // ws重连时触发
  onDisconnected: (closeCode?: number, messgae?: string) => void // 断开Client连接, 在Client主动销毁(ws达到最大重连次数或者MSE出错)时触发; 会关闭ws
  onVideoTimeUpdated: () => void // 视频的播放位置发生改变时执行的函数
  onMimeCodecCheck: (status: boolean) => void // 当视频解码格式校验时触发 status: true/false（false: 比如265在低版本浏览器上不支持）
  beforeClear: () => void // 视频控件清理前触发
  withReconnect: boolean // 是否需要重连
  reconnectTimeout: number // 重连间隔
  maxReconnectNum: number | 'infinity' // 重连最大次数
  [key: string]: any
}

const AVCCodecs = 'video/mp4; codecs="avc1.4d0029"' // h264 avc1.4d0029: supai; avc1.64002A: supos
const HEVCodecs = 'video/mp4; codecs="hev1.1.6.L120.90"' // h265 或者 "hev1.1.2.L153"

class StreamPlayer {
  private streamUrl: string | null = null

  private videoElem: HTMLVideoElement | null // video元素

  private options: RealplayOptions = {
    binaryType: 'arraybuffer',
    bufferMode: 'segments',
    onWsOpen: () => { },
    onWsClose: () => { },
    onWsReconnect: () => { },
    onDisconnected: (closeCode?: number) => { }, //  (closeCode -1: 除了ws以外的出错)
    onVideoTimeUpdated: () => { },
    onMimeCodecCheck: () => { },
    beforeClear: () => { }, // 视频控件清理前触发
    withReconnect: true,
    reconnectTimeout: 5000, // 5s
    maxReconnectNum: 'infinity', // "infinity"：无限次重连
  }

  public ws: WebSocketProxy | null = null // WebSocketProxy对象实例

  public mediaSourceStartTime: number | null = null // MSE开始接受流数据时间，用于计算视频播放延迟的时间差

  private isCreateMSE: boolean = false // 是否创建MSE实例

  private videoMimeCodec: string = AVCCodecs // 默认编码格式为264

  private firstReceiveMsg: boolean = false // 是否第一次接到消息，为了记录视频流开始时间

  private bufferSegments: Array<BufferSource | null> = [] // 视频流片段队列

  private mediaSource: MediaSource | null = null // MediaSource对象实例

  private sourceBuffer: SourceBuffer | null = null // SourceBuffer对象实例

  private destroyed: boolean = false // 是否销毁

  private needReconnected: boolean = false // 是否需要重连

  private timer: any = null // 重连定时器

  private reconnectedNum: number = 0 // 当前重连次数 心跳重连 + ws出错重连(连续的，有播放，则重置为0)

  constructor(
    streamUrl = '', // 流服务地址
    videoElem: HTMLVideoElement, // video元素
    options?: any
  ) {
    this.streamUrl = streamUrl

    if (videoElem) {
      this.videoElem = videoElem
    } else {
      const wapperVideoElement: HTMLVideoElement = document.createElement('video')
      document.body.appendChild(wapperVideoElement)
      this.videoElem = wapperVideoElement
    }

    if (options) {
      Object.keys(options).forEach((key) => {
        this.options[key] = options[key]
      })
    }

    this.createWs()
  }

  /**
   * 初始化websocket
   */
  private createWs = () => {
    console.log('createWs', this.streamUrl);
    if (this.streamUrl) {
      const { heartCheckTimeout } = this.options
      this.ws = new WebSocketProxy(this.streamUrl, '', {
        onOpen: this.onWebSocketOpen,
        onData: this.onWebSocketMessage,
        onClose: this.onWebSocketClose,
        heartCheckTimeout,
      })
      this.setHeartCheck()
    }
  }

  /**
   * ws连接
   */
  private onWebSocketOpen = () => {
    this.destroyed = false
    this.firstReceiveMsg = true
    this.isCreateMSE = false

    const { onWsOpen } = this.options
    if (onWsOpen) {
      onWsOpen()
    }
  }

  /**
   * 接收数据: 自动识别h264和h265
   * @param data
   */
  private onWebSocketMessage = (data: any) => {
    if (!this.isCreateMSE) {
      // step1：识别视频格式
      const unit = new Uint8Array(data)
      let unitCharCode = ''
      unit.forEach((u) => {
        unitCharCode += String.fromCharCode(u)
      })
      if (unitCharCode.indexOf('moov') > -1) {
        console.log('unitCharCode--', unitCharCode);
        if (unitCharCode.indexOf('hev') > -1) {
          // 查找265的编码信息
          this.videoMimeCodec = HEVCodecs
        } else {
          this.videoMimeCodec = AVCCodecs
        }
        // step2：创建MSE
        this.createMediaSource()
        this.isCreateMSE = true
      }
    }

    if (!this.destroyed) {
      this.setHeartCheck()
      this.bufferSegments.push(data)
      this.insertSegment()
    }

    if (this.firstReceiveMsg) {
      this.firstReceiveMsg = false
      this.mediaSourceStartTime = new Date().valueOf()
    }
  }

  /**
   * 断开ws连接
   * @param e
   */
  private onWebSocketClose = (closeEventCode: any) => {
    const { onWsClose } = this.options
    if (onWsClose) {
      onWsClose()
    }

    // 如果实例没有销毁，则清除MSE数据
    if (!this.destroyed) {
      this.clearMes()
    }
    this.reconnectWs()
  }

  // 重连WS
  public reconnectWs = () => {
    const { withReconnect } = this.options
    if (!withReconnect) {
      // 不需要重连
      return
    }
    if (this.timer === null && !this.destroyed) {
      const { maxReconnectNum } = this.options
      this.reconnectedNum += 1
      if (maxReconnectNum === 'infinity') {
        // 无限次重连
        const reconnectTimeout = this.getReconnectTimeoutWithNumber()
        this.setResetWsTimer(reconnectTimeout)
        return
      }
      if (this.reconnectedNum > maxReconnectNum) {
        // 超出最大重连次数
        this.clientDisconnected()
        return
      }

      // 重连定时器
      this.setResetWsTimer()
    }
  }

  /**
   * 设置重连定时器
   */
  private setResetWsTimer = (reconnectTimeout?: number) => {
    this.timer = setTimeout(() => {
      this.resetWs()
    }, reconnectTimeout || this.options.reconnectTimeout)
  }

  /**
   * 重置数据, 重新建立websocket通信重置数据, 重新建立websocket通信
   * @param newStreamUrl
   */
  public resetWs = (newStreamUrl?: string) => {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // 是否能删除
    const ifCanClear = !this.sourceBuffer || (this.sourceBuffer && !this.sourceBuffer.updating)

    if (newStreamUrl) {
      // 说明是外部调用(播放视频或者重播), 则重新计算重连次数
      this.streamUrl = newStreamUrl
      this.resetReconnectedNum()
    }

    if (ifCanClear) {
      if (this.options.onWsReconnect) {
        this.options.onWsReconnect()
      }
      this.createWs()
      this.needReconnected = false
    } else {
      this.needReconnected = true
    }
  }

  /**
   * 删除ws实例
   */
  private clearWs = () => {
    if (this.ws) {
      this.ws.destroy()
      this.ws = null
    }
  }

  /**
   * 初始化MediaSource, 并与video绑定
   */
  private createMediaSource = () => {
    if ('MediaSource' in window && MediaSource.isTypeSupported(this.videoMimeCodec)) {
      if (this.options.onMimeCodecCheck) {
        this.options.onMimeCodecCheck(true)
      }
      this.bufferSegments = []

      // 新建MediaSource对象
      this.mediaSource = new MediaSource()
      // 给video.src赋值之后触发
      this.mediaSource.onsourceopen = this.onMediaSourceOpen
      this.mediaSource.onsourceclose = this.onMediaSourceClose

      if (this.videoElem) {
        // 创建URL对象, 当不再需要时,必须调用 URL.revokeObjectURL(objectURL)来释放
        this.videoElem.src = URL.createObjectURL(this.mediaSource)

        // 解决浏览器tab切换，导致video播放暂停
        // 解决方法1：
        this.videoElem.onpause = this.onVideoPause

        // 解决方法2：
        document.addEventListener('visibilitychange', this.onVideoVisibilitychange)
      }
    } else {
      console.error('Unsupported MIME type or codec')
      if (this.options.onMimeCodecCheck) {
        this.options.onMimeCodecCheck(false)
      }
      this.clearWs()
    }
  }

  /**
   * 给video.src赋值之后触发
   * 创建SourceBuffer实例，用于操作视频流
   * 初始化WebSocket实例
   */
  private onMediaSourceOpen = () => {
    if (this.videoElem) {
      // 释放通过URL.createObjectURL()创建的对象URL
      URL.revokeObjectURL(this.videoElem.src)

      if (!this.streamUrl) {
        return
      }

      if (!this.sourceBuffer && this.mediaSource) {
        // 创建 SourceBuffer 对象
        this.sourceBuffer = this.mediaSource.addSourceBuffer(this.videoMimeCodec)
        this.sourceBuffer!.mode = this.options.bufferMode
        // appendBuffer 或 remove结束时触发
        this.sourceBuffer.onupdateend = this.onSourceBufferUpdateend
        this.sourceBuffer.onerror = () => {
          this.needReconnected = true
        }
      }
    }
  }

  private onMediaSourceClose = () => {
    // 当视频编码出错时，MediaSource也会主动关闭
    if (!this.destroyed) {
      this.clear()
      this.reconnectWs()
    }
  }

  /**
   * appendBuffer 或 remove 结束时触发
   */
  private onSourceBufferUpdateend = () => {
    if (this.destroyed) {
      // 已经销毁
      this.clear()
    } else if (this.needReconnected) {
      this.clear()
      this.reconnectWs()
    } else if (this.canUpdateSourceBuffer()) {
      const { currentTime } = this.videoElem! // 返回视频中的当前播放位置(以秒计)
      const timeRanges = this.sourceBuffer!.buffered // 获取已缓冲视频的时间范围(包括一个或多个时间范围)
      // 正常情况下，最多存在一段缓冲区
      const timeRangeStart = timeRanges.length > 0 ? timeRanges.start(0) : 0
      if (timeRanges.length > 0 && currentTime - timeRangeStart > 30) {
        this.sourceBuffer!.remove(timeRangeStart, currentTime - 10)
      } else {
        this.insertSegment()
      }
    }
  }

  /**
   * 添加视频片段
   */
  private insertSegment = () => {
    if (this.bufferSegments.length > 0 && this.canUpdateSourceBuffer()) {
      // 当前存在视频流且sourceBuffer没有操作中(appendBuffer/remove结束)
      // sourceBuffer在更新则不会添加
      const segment = this.bufferSegments.shift() // 队列中的第一个视频流
      try {
        if (segment) {
          // 向 MediaSource 中添加视频片段
          this.sourceBuffer!.appendBuffer(segment)
        }
      } catch (error) {
        // https://developer.mozilla.org/zh-CN/docs/Web/API/MediaSource/addSourceBuffer
        // 重连
        // this.clientDisconnected(-1, error.name); // QuotaExceededError
        this.clear()
        this.reconnectWs()
      }
    }
  }

  /**
   * 当前MediaSource是否处于open状态。只有处于open状态，才能对SourceBuffer进行操作
   * @returns
   */
  private ifMediaSourceOpen = () => {
    if (this.mediaSource) {
      return this.mediaSource.readyState === 'open'
    }
    return false
  }

  /**
   * 是否可以更新sourceBuffer; 有视频元素; MSE打开; sourceBuffer没在更新中
   * @returns SourceBuffer
   */
  private canUpdateSourceBuffer = () => {
    if (this.videoElem && this.ifMediaSourceOpen() && this.sourceBuffer && !this.sourceBuffer.updating) {
      return true
    }
    return false
  }

  /**
   * 视频当前时间是否可以被修正; 有视频元素; MSE打开; sourceBuffer没在更新中
   * @returns SourceBuffer
   */
  private canVideoCurrentTimeCorrection = () => {
    if (this.videoElem && this.ifMediaSourceOpen() && this.sourceBuffer && this.sourceBuffer.buffered.length > 0) {
      return true
    }
    return false
  }

  /**
   * 清除ws MSE相关缓存
   */
  private clearMes = () => {
    const { beforeClear } = this.options
    beforeClear()

    // 是否能删除
    const ifCanClear = !this.sourceBuffer || (this.sourceBuffer && !this.sourceBuffer.updating)

    if (this.sourceBuffer) {
      // 存在sourceBuffer对象
      if (this.sourceBuffer.updating) {
        // sourceBuffer还在更新中, 在onupdateend中处理
      } else {
        if (this.ifMediaSourceOpen()) {
          try {
            const timeRanges: any = this.sourceBuffer?.buffered ?? []; // 获取已缓冲视频的时间范围(包括一个或多个时间范围)
            if (timeRanges && timeRanges.length > 0) {
              // 正常情况下，最多存在一段缓冲区
              this.sourceBuffer.remove(timeRanges.start(0), timeRanges.end(0))

              if (this.mediaSource) {
                // 从mediaSource中删除sourceBuffer
                if (this.mediaSource.sourceBuffers) {
                  for (let i = 0; i < this.mediaSource.sourceBuffers.length; i += 1) {
                    this.mediaSource.removeSourceBuffer(this.mediaSource.sourceBuffers[i])
                  }
                }
              }
            }
          } catch (err) {
            console.log('err')
          }
        }

        this.sourceBuffer.onupdateend = null
        this.endOfMediaSourceStream()
      }
    } else {
      this.endOfMediaSourceStream()
    }

    this.bufferSegments = []

    return ifCanClear
  }

  private endOfMediaSourceStream = () => {
    // 结束流
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      // 结束当前的接受，注意，并不是断开; 当 endOfStream() 执行完成，状态变为ended
      this.mediaSource.endOfStream()
    }
    this.mediaSource = null
    this.sourceBuffer = null
    if (this.videoElem) {
      this.videoElem.src = '' // 需要清除src, 否则重新创建mes时不会触发onsourceopen事件
      this.videoElem.onpause = null
    }
  }

  private onVideoVisibilitychange = () => {
    if (document.visibilityState === 'visible' && this.canVideoCurrentTimeCorrection()) {
      this.videoElem!.currentTime = this.sourceBuffer!.buffered.end(0) - 0.5
    }
  }

  private onVideoPause = () => {
    if (this.canVideoCurrentTimeCorrection()) {
      this.videoElem!.play()
    }
  }

  /**
   * 开启心跳检测
   */
  private setHeartCheck = () => {
    if (this.ws) {
      this.ws.heartCheck()
    }
  }

  /**
   * 销毁实例，触发断开连接的回调
   * @param code CloseEvent.code or -1
   */
  private clientDisconnected = (code?: number, detail?: string) => {
    this.destroy()
    const { onDisconnected } = this.options
    if (onDisconnected) {
      // [CloseEvent.code](https://developer.mozilla.org/zh-CN/docs/Web/API/CloseEvent)
      onDisconnected(code, detail)
    }
  }

  /**
   * 不同重连次数对应的ws重连间隔;
   * 针对无限次重连的情况
   * @returns
   */
  private getReconnectTimeoutWithNumber = () => {
    const reconnectTimeoutArr = [1000, 3000, 5000, 10000, 20000, 30000, 60000]
    const len = reconnectTimeoutArr.length
    const reconnectedNum = this.reconnectedNum - 1 >= 0 ? this.reconnectedNum - 1 : 0
    if (reconnectedNum >= len) {
      return reconnectTimeoutArr[len - 1]
    }
    return reconnectTimeoutArr[reconnectedNum]
  }

  /**
   * 重置当前重连次数
   */
  private resetReconnectedNum = () => {
    this.reconnectedNum = 0
  }

  /**
   * 用于清除ws和mes数据
   */
  public clear = () => {
    this.clearWs()
    this.clearMes()
  }

  /**
   * 用于视频控件销毁
   */
  public destroy = () => {
    this.destroyed = true
    this.needReconnected = false
    this.clear()

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

export default StreamPlayer

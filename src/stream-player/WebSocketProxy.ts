/**
 * WebSocket类 协议层
 * 作用：接收封装后的数据流; 派发数据
 */

type BufferSource = ArrayBufferView | ArrayBuffer

class WebSocketProxy {
  private url: string // ws服务地址

  private protocol: string | undefined // 协议

  private ws: WebSocket | null = null

  private onOpen?: () => void

  private onData?: (data: BufferSource) => void

  private onClose?: (closeCode: any, closeDetail?: string) => void // closeCode: 关闭码 closeDetail: 关闭信息 ws关闭的回调

  private heartCheckServerTimer: any = null // 心跳服务超时定时器, 心跳服务也受重连次数限制

  private heartCheckTimeout: number = 60000 // 心跳定时间隔

  num = 0 // 自测数据

  constructor(
    wsurl: string,
    protocol: string | undefined,
    options: {
      onOpen?: () => void // 建立连接
      onData?: (data: BufferSource) => void // 接收数据
      onClose?: (closeCode: number, closeDetail?: string) => void // ws关闭
      heartCheckTimeout?: number
    }
  ) {
    this.url = wsurl
    this.protocol = protocol

    this.onOpen = options.onOpen
    this.onData = options.onData
    this.onClose = options.onClose
    if (options.heartCheckTimeout) {
      this.heartCheckTimeout = options.heartCheckTimeout
    }

    this.connect()
  }

  /**
   * 销毁
   */
  destroy() {
    if (this.ws) {
      // 不會再觸發handleDisconnect
      this.ws.onclose = (ev) => {
        this.ws = null
        this.dispatchClose(ev)
      }
      this.closeWs()
    }
    // TODO 多个websocket存在，第一个websocket onclose触发会有延迟 ？？？？
    this.ws = null
    this.clearHeartCheckTimer()
  }

  /**
   * 心跳启动
   */
  heartCheck(heartCheckTimeout?: number) {
    // 清除上次心跳定时器
    this.clearHeartCheckTimer()

    this.heartCheckServerTimer = setTimeout(() => {
      // 发起心跳60s后，未收到数据，则认定连接失败，关闭ws触发重连
      if (this.ws) {
        this.closeWs()
      }
    }, heartCheckTimeout || this.heartCheckTimeout)
  }

  /**
   * 关闭websocket
   */
  private closeWs() {
    // if (this.ws && this.ws.readyState === this.ws.OPEN) {
    //   this.ws.close();
    // }
    if (this.ws) {
      this.ws.close() // readyState: WebSocket.CLOSED
    }
  }

  /**
   * 建立连接
   */
  private connect() {
    if (this.url) {
      if (this.protocol) {
        this.ws = new WebSocket(this.url, this.protocol)
      } else {
        this.ws = new WebSocket(this.url)
      }

      this.ws.binaryType = 'arraybuffer' // websocket传输的二进制数据类型
      this.ws.onopen = () => {
        // websocket 连接已经准备好
        if (this.onOpen) {
          this.onOpen()
        }
      }
      this.ws.onmessage = (ev) => {
        if (this.onData) {
          this.onData(ev.data)
        }
      }
      this.ws.onerror = (ev) => {
        if (this.ws) {
          this.closeWs()
        }
      }
      this.ws.onclose = (ev) => {
        this.clearHeartCheckTimer()
        this.handleClose(ev)
      }
    }
  }

  /**
   * 监听close
   */
  private handleClose(ev: CloseEvent) {
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onmessage = null
    }

    this.dispatchClose(ev)
  }

  /**
   * 触发传入的close
   * @param ev
   */
  private dispatchClose(ev: CloseEvent) {
    if (this.onClose) {
      // TODO: [CloseEvent.code](https://developer.mozilla.org/zh-CN/docs/Web/API/CloseEvent) [1000, 1006, 1013, 1011]
      this.onClose(ev.code)
    }
  }

  /**
   * 清除心跳定时器
   */
  private clearHeartCheckTimer() {
    if (this.heartCheckServerTimer) {
      clearTimeout(this.heartCheckServerTimer)
      this.heartCheckServerTimer = null
    }
  }
}

export default WebSocketProxy

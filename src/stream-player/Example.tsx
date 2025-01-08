import React, { useRef, useEffect } from 'react'
import StreamPlayer from './index'
import fmp4 from './frag_bunny.mp4'
import './styles.less'

export const Example = () => {
  const videoFileRef = useRef<any>(null)
  const videoRef = useRef<any>(null)
  const streamPlayerRef = useRef<any>(null)
  const mediaSource = useRef<any>(null)

  useEffect(() => {
    const wsUrl =
      'ws://xxxx/rtstream?type=fmp4' // ws流
      streamPlayerRef.current = new StreamPlayer(wsUrl, videoRef.current, {
      withReconnect: true,
      maxReconnectNum: 5,
      reconnectTimeout: 60000,
      onWsOpen: () => {},
      onWsClose: () => {},
      onWsReconnect: () => {},
      beforeClear: () => {},
      onDisconnected: () => {},
      onMimeCodecCheck: () => {},
    })
  }, [])

  return (
    <div className="player-container">
      <h2>video直接播放fmp4文件：</h2>
      <video src={fmp4} muted autoPlay className="player-video" />
      <h2>MSE支持本地fmp4转为流文件进行播放：</h2>
      <input
        type="file"
        onChange={(e) => {
          const mimeCodec = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'

          if ('MediaSource' in window && MediaSource.isTypeSupported(mimeCodec)) {
            mediaSource.current = new MediaSource()
            videoFileRef.current.src = URL.createObjectURL(mediaSource.current)
            mediaSource.current.addEventListener('sourceopen', sourceOpen)
          } else {
            console.error('Unsupported MIME type or codec: ', mimeCodec)
          }

          function sourceOpen(_) {
            const sourceBuffer = mediaSource.current.addSourceBuffer(mimeCodec)
            sourceBuffer.addEventListener('updateend', function (_) {
              mediaSource.current.endOfStream()
              videoFileRef.current.play()
            })
            console.log('fmp4', e.target.files[0])
            const file = e.target.files[0]
            const reader = new FileReader()
            reader.readAsArrayBuffer(file)
            reader.onload = (e) => {
              console.log('buffer', e.target.result)
              sourceBuffer.appendBuffer(e.target.result)
            }
          }
        }}
      />
      <br />
      <video ref={videoFileRef} muted autoPlay className="player-video" />
      <h2>MSE实时播放监控视频FMP4流文件：</h2>
      <video
        ref={videoRef}
        muted
        autoPlay
        className="player-video" // 不保证保持原有的比例，内容拉伸填充整个内容容器。
      />
    </div>
  )
}


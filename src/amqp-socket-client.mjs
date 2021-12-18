import AMQPBaseClient from './amqp-base-client.mjs'
import AMQPError from './amqp-error.mjs'
import AMQPView from './amqp-view.mjs'
import { Buffer } from 'buffer'
import net from 'net'
import tls from 'tls'
import process from 'process'

/**
 * AMQP 0-9-1 client over TCP socket.
 */
export default class AMQPClient extends AMQPBaseClient {
  /**
   * @param {string} url - uri to the server, example: amqp://user:passwd@localhost:5672/vhost
   */
  constructor(url) {
    const u = new URL(url)
    const vhost = decodeURIComponent(u.pathname.slice(1)) || "/"
    const username = u.username || "guest"
    const password = u.password || "guest"
    const name = u.searchParams.get("name")
    const platform = `${process.release.name} ${process.version} ${process.platform} ${process.arch}`
    super(vhost, username, password, name, platform)
    this.tls = u.protocol === "amqps:"
    this.host = u.hostname || "localhost"
    this.port = parseInt(u.port) || (this.tls ? 5671 : 5672)
    /** @type {net.Socket?} */
    this.socket = null
  }

  /**
   * Try establish a connection
   * @return {Promise<AMQPBaseClient>}
   */
  connect() {
    const socket = this.connectSocket()
    Object.defineProperty(this, 'socket', {
      value: socket,
      enumerable: false // hide it from console.log etc.
    })
    return new Promise((resolve, reject) => {
      socket.on('error', (err) => reject(new AMQPError(err.message, this)))
      this.connectPromise = /** @type {[function(AMQPBaseClient) : void, function(Error) : void]} */ ([resolve, reject])
    })
  }

  /**
    * @private
    */
  connectSocket() {
    let framePos = 0
    let frameSize = 0
    const frameBuffer = Buffer.allocUnsafe(16384)
    const self = this
    const options = {
      host: this.host,
      port: this.port,
      servername: this.host, // SNI
      onread: {
        buffer: Buffer.allocUnsafe(128 * 1024),
        callback: (/** @type {number} */ bytesWritten, /** @type {Buffer} */ buf) => {
          // A socket read can contain 0 or more frames, so find frame boundries
          let bufPos = 0
          while (bufPos < bytesWritten) {
            // read frame size of next frame
            if (frameSize === 0) {
              // first 7 bytes of a frame was split over two reads
              if (framePos !== 0) {
                const copied = buf.copy(frameBuffer, framePos, bufPos, bufPos + 7 - framePos)
                if (copied === 0) throw `Copied 0 bytes framePos=${framePos} bufPos=${bufPos} bytesWritten=${bytesWritten}`
                framePos += copied
                bufPos += copied
                frameSize = frameBuffer.readInt32BE(3) + 8
                continue
              }
              // frame header is split over reads, copy to frameBuffer
              if (bufPos + 3 + 4 > bytesWritten) {
                const copied = buf.copy(frameBuffer, framePos, bufPos, bytesWritten)
                if (copied === 0) throw `Copied 0 bytes framePos=${framePos} bufPos=${bufPos} bytesWritten=${bytesWritten}`
                framePos += copied
                break
              }

              frameSize = buf.readInt32BE(bufPos + 3) + 8

              // avoid copying if the whole frame is in the read buffer
              if (bytesWritten - bufPos >= frameSize) {
                const view = new AMQPView(buf.buffer, buf.byteOffset + bufPos, frameSize)
                self.parseFrames(view)
                bufPos += frameSize
                framePos = frameSize = 0
                continue
              }
            }

            const leftOfFrame = frameSize - framePos
            const copyBytes = Math.min(leftOfFrame, bytesWritten - bufPos)
            const copied = buf.copy(frameBuffer, framePos, bufPos, bufPos + copyBytes)
            if (copied === 0) throw `Copied 0 bytes, please report this bug, frameSize=${frameSize} framePos=${framePos} bufPos=${bufPos} copyBytes=${copyBytes} bytesWritten=${bytesWritten}`
            framePos += copied
            bufPos += copied
            if (framePos === frameSize) {
              const view = new AMQPView(frameBuffer.buffer, 0, frameSize)
              self.parseFrames(view)
              frameSize = framePos = 0
            }
          }
          return true
        }
      }
    }
    if (this.tls)
      return tls.connect(options, () => this.send(new Uint8Array([65, 77, 81, 80, 0, 0, 9, 1])))
    else
      return net.connect(options, () => this.send(new Uint8Array([65, 77, 81, 80, 0, 0, 9, 1])))
  }

  /**
   * @ignore
   * @param {Uint8Array} bytes to send
   * @return {Promise<void>} fulfilled when the data is enqueued
   */
  send(bytes) {
    return new Promise((resolve, reject) => {
      if (this.socket)
        this.socket.write(bytes, undefined, (err) => err ? reject(err) : resolve())
      else
        reject("Socket not connected")
    })
  }

  /**
   * @protected
   */
  closeSocket() {
    if(this.socket) this.socket.end()
  }
}

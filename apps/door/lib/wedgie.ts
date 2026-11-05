/**
 * The Wedgie over Web Serial: JSON lines both ways, and each request's answer is the line carrying its id
 * (wedgie.dev/usb.md). Chrome and Edge only; one page at a time holds the port (R8).
 */
export type Message = { type: string; id?: number; [k: string]: unknown }

/** Raspberry Pi's USB vendor id: every Wedgie. */
const PICO = 0x2e8a

export class Wedgie {
  private next = 1
  private waiting = new Map<number, (m: Message) => void>()
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private reading: Promise<void>
  private gone = false
  /** Called once when the port goes: unplugged, or closed. */
  onclose?: () => void

  private constructor(private port: SerialPort) {
    this.writer = port.writable!.getWriter()
    this.reading = this.read()
  }

  static supported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator
  }

  /** A Wedgie this page was let into before: no picker. */
  static async known(): Promise<Wedgie | null> {
    const port = (await navigator.serial.getPorts()).find((p) => p.getInfo().usbVendorId === PICO)
    return port ? Wedgie.open(port) : null
  }

  /** Chrome's port picker, showing Wedgies only. */
  static async pick(): Promise<Wedgie> {
    return Wedgie.open(await navigator.serial.requestPort({ filters: [{ usbVendorId: PICO }] }))
  }

  private static async open(port: SerialPort): Promise<Wedgie> {
    await port.open({ baudRate: 115200 })
    return new Wedgie(port)
  }

  /** One request; its answer, or an error after timeoutMs (a press prompt waits up to 120 s on the Wedgie). */
  ask(msg: Message, timeoutMs = 5000): Promise<Message> {
    if (this.gone) return Promise.reject(new Error('the Wedgie is not connected'))
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`the Wedgie didn't answer ${msg.type} within ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.waiting.set(id, (m) => {
        clearTimeout(timer)
        resolve(m)
      })
      this.writer.write(new TextEncoder().encode(`${JSON.stringify({ ...msg, id })}\n`)).catch((e) => {
        clearTimeout(timer)
        this.waiting.delete(id)
        reject(e)
      })
    })
  }

  private async read() {
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (this.port.readable && !this.gone) {
        const reader = this.port.readable.getReader()
        this.reader = reader
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) return
            buf += decoder.decode(value, { stream: true })
            for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
              this.line(buf.slice(0, nl))
              buf = buf.slice(nl + 1)
            }
          }
        } finally {
          reader.releaseLock()
        }
      }
    } catch {
      // unplugged: the stream errors out
    } finally {
      this.end()
    }
  }

  private line(text: string) {
    let m: unknown
    try {
      m = JSON.parse(text)
    } catch {
      return // not one of ours: the firmware's own chatter
    }
    if (m && typeof m === 'object' && typeof (m as Message).id === 'number') {
      const id = (m as Message).id as number
      this.waiting.get(id)?.(m as Message)
      this.waiting.delete(id)
    }
  }

  private end() {
    if (this.gone) return
    this.gone = true
    this.onclose?.()
  }

  get connected(): boolean {
    return !this.gone
  }

  async close() {
    this.gone = true
    await this.reader?.cancel().catch(() => {})
    await this.reading.catch(() => {})
    this.writer.releaseLock()
    await this.port.close().catch(() => {})
    this.onclose?.()
  }
}

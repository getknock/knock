import encodeQR from 'qr'

/**
 * The QR code the Wedgie draws for a link (D13), as `knock_qr` takes it: byte mode at ECC H (which mends what
 * Knock's logo covers), n x n modules row by row, the high bit first, 1 dark. The Wedgie adds its own quiet zone.
 */
export function knockQr(text: string): { n: number; bits: `0x${string}` } {
  // The encoder insists on a quiet zone: ask for one module and slice it off, as its own notes say.
  const ringed = encodeQR(text, 'raw', { ecc: 'high', encoding: 'byte', border: 1 })
  const modules = ringed.slice(1, -1).map((row) => row.slice(1, -1))
  const n = modules.length
  const bytes = new Uint8Array(Math.ceil((n * n) / 8))
  modules.flat().forEach((dark, i) => {
    if (dark) bytes[i >> 3] |= 0x80 >> (i & 7)
  })
  return { n, bits: `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` }
}

/** Whether module (row, col) of knock_qr's bits is dark. */
export function dark(n: number, bits: string, row: number, col: number): boolean {
  const i = row * n + col
  return ((parseInt(bits.slice(2 + 2 * (i >> 3), 4 + 2 * (i >> 3)), 16) << (i & 7)) & 0x80) !== 0
}

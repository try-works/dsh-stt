/** Canonical-WAV handling and longest-possible segmentation for engines with a duration cap. */

/** Bytes per second of the seam's canonical format: 16 kHz mono PCM16. */
export const BYTES_PER_SECOND = 32000

/**
 * Read a RIFF/WAVE file's format and audio payload.
 *
 * The seam hands providers a canonical 44-byte WAV, but a file that reached us any
 * other way may carry extra chunks (ffmpeg inserts a LIST), so walk the chunk list
 * rather than assuming a header length.
 *
 * @param bytes - the complete file.
 * @returns the PCM payload and the format fields we rely on.
 */
export function parseWav(bytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('audio is not a RIFF/WAVE file')
  }
  let offset = 12
  let format = null
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      const length = Math.min(size, bytes.length - body)
      if (format === null) throw new Error('audio has a data chunk before its format')
      return { ...format, data: bytes.subarray(body, body + length), bytesPerSecond: format.sampleRate * format.channels * (format.bitsPerSample / 8) }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('audio carries no data chunk')
}

/**
 * Wrap PCM payload in a canonical 44-byte WAV header.
 * @param pcm - 16 kHz mono PCM16 samples.
 * @returns the complete file bytes.
 */
export function canonicalWav(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(BYTES_PER_SECOND, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Root-mean-square amplitude of one 20 ms frame, or Infinity when the frame is out of range. */
function frameRms(data, at) {
  if (at + 640 > data.length) return Infinity
  let sum = 0
  for (let i = 0; i < 320; i += 1) {
    const sample = data.readInt16LE(at + i * 2) / 32768
    sum += sample * sample
  }
  return Math.sqrt(sum / 320)
}

/**
 * Split PCM into segments no longer than the engine's cap.
 *
 * A cut through the middle of a word costs accuracy at the seam, so the boundary is
 * moved back to the quietest 20 ms frame in the last stretch of the segment. Continuous
 * speech has no silence to find, in which case the hard limit is used.
 *
 * @param data - 16 kHz mono PCM16 payload.
 * @param limitSeconds - the engine's maximum segment length.
 * @returns one or more `[startByte, endByte)` ranges covering the payload.
 */
export function segment(data, limitSeconds) {
  const limitBytes = Math.floor(limitSeconds * BYTES_PER_SECOND)
  if (data.length <= limitBytes) return [[0, data.length]]
  const spans = []
  let start = 0
  while (start < data.length) {
    const hardEnd = Math.min(data.length, start + limitBytes)
    if (hardEnd >= data.length) {
      spans.push([start, data.length])
      break
    }
    // Search the last third of the segment for the quietest frame.
    const searchFrom = start + Math.floor(limitBytes * 0.66)
    let bestAt = hardEnd
    let bestRms = Infinity
    for (let at = searchFrom; at + 640 <= hardEnd; at += 640) {
      const rms = frameRms(data, at)
      if (rms < bestRms) {
        bestRms = rms
        bestAt = at
      }
    }
    spans.push([start, bestAt])
    start = bestAt
  }
  return spans
}

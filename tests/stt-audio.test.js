/** Canonical-WAV parsing and segmentation, the pieces that lift the engine's 30 s cap. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BYTES_PER_SECOND, canonicalWav, parseWav, segment } from '../src/provider-kit/audio.js'

/** Build a canonical WAV of a given length with a known sample pattern. */
function wav(seconds, fill = 1000) {
  const pcm = Buffer.alloc(Math.floor(seconds * BYTES_PER_SECOND))
  pcm.fill(0)
  for (let at = 0; at + 2 <= pcm.length; at += 2) pcm.writeInt16LE(fill, at)
  return canonicalWav(pcm)
}

test('parseWav reads a canonical recording', () => {
  const parsed = parseWav(wav(1))
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.bitsPerSample, 16)
  assert.equal(parsed.bytesPerSecond, 32000)
  assert.equal(parsed.data.length, 32000)
})

test('parseWav walks past chunks that precede the audio', () => {
  // ffmpeg inserts a LIST chunk, which puts `data` at byte 78 rather than 44.
  const base = wav(1)
  const list = Buffer.alloc(8 + 26)
  list.write('LIST', 0, 'ascii')
  list.writeUInt32LE(26, 4)
  const head = base.subarray(0, 12)
  const rest = base.subarray(12)
  const shifted = Buffer.concat([head, list, rest])
  shifted.writeUInt32LE(shifted.length - 8, 4)
  const parsed = parseWav(shifted)
  assert.equal(parsed.data.length, 32000)
  assert.equal(parsed.data[0], base[44])
})

test('parseWav refuses input that is not a WAV', () => {
  assert.throws(() => parseWav(Buffer.from('not a wav at all, really')), /RIFF\/WAVE/)
  assert.throws(() => parseWav(Buffer.alloc(0)), /RIFF\/WAVE/)
})

test('canonicalWav round-trips through parseWav', () => {
  const parsed = parseWav(canonicalWav(Buffer.alloc(1000, 7)))
  assert.equal(parsed.data.length, 1000)
  assert.equal(parsed.data[0], 7)
})

test('segment leaves a recording inside the cap as one span', () => {
  const data = Buffer.alloc(10 * BYTES_PER_SECOND)
  assert.deepEqual(segment(data, 29.5), [[0, data.length]])
})

test('segment covers the whole recording with spans inside the cap', () => {
  const data = Buffer.alloc(Math.floor(75 * BYTES_PER_SECOND))
  const spans = segment(data, 29.5)
  assert.ok(spans.length >= 3, 'seventy-five seconds needs at least three segments')
  assert.equal(spans[0][0], 0)
  assert.equal(spans[spans.length - 1][1], data.length)
  for (const [from, to] of spans) {
    assert.ok(to > from, 'every span must advance')
    assert.ok((to - from) / BYTES_PER_SECOND <= 29.5, 'no span may exceed the cap')
  }
  for (let i = 1; i < spans.length; i += 1) assert.equal(spans[i][0], spans[i - 1][1], 'spans join exactly')
})

test('segment prefers a quiet moment over cutting through sound', () => {
  const seconds = 40
  const data = Buffer.alloc(Math.floor(seconds * BYTES_PER_SECOND))
  // Loud everywhere, with one silent 20 ms frame well inside the boundary search window.
  for (let at = 0; at + 2 <= data.length; at += 2) data.writeInt16LE(20000, at)
  const quietAt = Math.floor(26 * BYTES_PER_SECOND)
  data.fill(0, quietAt, quietAt + 640)
  const spans = segment(data, 29.5)
  assert.ok(spans.length >= 2)
  const firstLength = spans[0][1] - spans[0][0]
  assert.ok(Math.abs(firstLength - quietAt) < BYTES_PER_SECOND, 'the first cut should land on the silent frame')
})

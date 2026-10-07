/**
 * The browser half, exercised the way the page loads it.
 *
 * src/client/index.js IS the shipped artifact - the client module system serves that
 * file to the page as a lazy-CJS bundle - so the suite loads it through a stub
 * __ModuleLoader__ and calls the factory with a stub require, exactly as the browser
 * does. It cannot be imported piecemeal, which is why the pure helpers are exported
 * under `internals`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The bare minimum of React the factory touches at module scope. */
const REACT_STUB = {
  Fragment: function Fragment() {},
  createElement: (type, props, ...children) => ({ type, props: props === null || props === undefined ? {} : props, children }),
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/** Load the bundle the way the page loader does. */
async function loadBundle() {
  let entry = null
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (captured) => { entry = captured } } }
  try {
    await import(new URL('../src/client/index.js', import.meta.url).href)
  } finally {
    globalThis.window = previous
  }
  assert.ok(entry !== null, 'the bundle must register itself with __ModuleLoader__')
  assert.equal(entry.id, '@try-works/dsh-stt', 'the bundle id must be the package name')
  return entry.factory((name) => {
    if (name === 'react') return REACT_STUB
    throw new Error('the bundle must not require anything else, saw: ' + name)
  })
}

const plugin = await loadBundle()
const { SilenceGate, VoiceActivity, audioBase64, encodeWav, microphoneHint, resample } = plugin.internals

test('the bundle exports a cordis plugin that waits for the speech remote', () => {
  assert.equal(plugin.name, 'dsh-stt', 'cordis names the fiber from this')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('slots'), 'the slot registry is required')
  assert.ok(plugin.inject.includes('remote'), 'the parent service must be declared, or ctx.remote throws')
  assert.ok(plugin.inject.includes('remote.speech'), 'wait for the generated speech Remote')
})

test('apply shadows the shipped microphone at a lower priority', () => {
  const seen = []
  const ctx = {
    remote: { speech: {} },
    effect: (run) => run(),
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => { seen.push({ options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].options.name, 'conversation.input.activity')
  assert.equal(seen[0].options.priority, -1, 'the shipped occupant registers at 0, so anything lower renders')
  assert.equal(typeof seen[0].component, 'function')
})

test('microphoneHint explains an unavailable microphone instead of staying silent', () => {
  assert.match(microphoneHint(null, false, ''), /Connecting/)
  assert.match(microphoneHint(null, false, 'boom'), /unavailable: boom/)
  assert.equal(microphoneHint({}, true, ''), 'Dictate', 'a ready provider is just an invitation')
  assert.match(microphoneHint({}, false, ''), /No model is ready/)
})

test('the microphone renders while the catalog is still unknown', () => {
  const tree = VoiceActivity({
    inputActions: { captureInsertion: () => ({}), insertText: () => true },
    locked: false,
    onActiveChange: () => {},
    speech: undefined,
  })
  assert.ok(tree !== null && tree !== undefined, 'rendering must not throw with no speech Remote')
  const button = tree.children[0]
  assert.equal(button.type, 'button')
  assert.match(button.props.title, /Connecting/)
  assert.match(button.props['aria-label'], /Connecting/)
})

test('clicking an unavailable microphone answers rather than doing nothing', () => {
  let expanded = null
  const tree = VoiceActivity({
    inputActions: { captureInsertion: () => ({}), insertText: () => true },
    locked: false,
    onActiveChange: (value) => { expanded = value },
    speech: undefined,
  })
  const button = tree.children[0]
  assert.doesNotThrow(() => { button.props.onClick() })
  assert.equal(expanded, null, 'the click itself must not require the owner to react')
})

test('resample returns the input untouched when the rates already match', () => {
  const input = new Float32Array([1, 2, 3])
  assert.equal(resample(input, 16000, 16000), input)
})

test('resample converts a 48 kHz ramp to 16 kHz', () => {
  const input = new Float32Array(4800)
  for (let i = 0; i < input.length; i += 1) input[i] = i / input.length
  const output = resample(input, 48000)
  assert.equal(output.length, 1600)
  assert.ok(output[output.length - 1] > output[0], 'the ramp must stay increasing')
})

test('encodeWav writes the canonical header the seam validates', () => {
  const view = new DataView(encodeWav(new Float32Array(1600)))
  const ascii = (at, length) => {
    let text = ''
    for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(at + i))
    return text
  }
  assert.equal(ascii(0, 4), 'RIFF')
  assert.equal(ascii(8, 4), 'WAVE')
  assert.equal(ascii(12, 4), 'fmt ')
  assert.equal(ascii(36, 4), 'data')
  assert.equal(view.getUint32(16, true), 16)
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(28, true), 32000)
  assert.equal(view.getUint16(32, true), 2)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(4, true), view.byteLength - 8)
  assert.equal(view.getUint32(40, true), view.byteLength - 44)
})

test('encodeWav clamps and scales samples to signed 16-bit', () => {
  const view = new DataView(encodeWav(new Float32Array([0, 1, -1, 2, -2])))
  assert.equal(view.getInt16(44, true), 0)
  assert.equal(view.getInt16(46, true), 32767)
  assert.equal(view.getInt16(48, true), -32768)
  assert.equal(view.getInt16(50, true), 32767, 'above range clamps')
  assert.equal(view.getInt16(52, true), -32768, 'below range clamps')
})

test('audioBase64 encodes a long recording without overflowing the call stack', () => {
  const bytes = new Uint8Array(200000)
  bytes[0] = 82
  bytes[199999] = 70
  const encoded = audioBase64(bytes.buffer)
  const decoded = Buffer.from(encoded, 'base64')
  assert.equal(decoded.length, bytes.length)
  assert.equal(decoded[0], 82)
  assert.equal(decoded[199999], 70)
})

test('the silence gate does not stop on a brief noise', () => {
  const gate = new SilenceGate({ threshold: 0.02, holdMs: 1000, minSpeechMs: 300, maxMs: 60000 })
  assert.equal(gate.push(0.5, 0), null)
  assert.equal(gate.push(0.5, 200), null)
  assert.equal(gate.push(0.01, 300), null)
  assert.equal(gate.push(0.01, 1400), null, 'a short noise cannot end the recording')
})

test('the silence gate stops after enough speech and a long enough pause', () => {
  const gate = new SilenceGate({ threshold: 0.02, holdMs: 1000, minSpeechMs: 300, maxMs: 60000 })
  for (let at = 0; at <= 600; at += 100) assert.equal(gate.push(0.5, at), null)
  assert.equal(gate.push(0.01, 700), null, 'the pause starts at the first quiet frame')
  assert.equal(gate.push(0.01, 1500), null, 'not quiet for long enough yet')
  assert.equal(gate.push(0.01, 1750), 'silence')
})

test('the silence gate honours the maximum duration', () => {
  const gate = new SilenceGate({ threshold: 0.02, holdMs: 5000, minSpeechMs: 300, maxMs: 2000 })
  assert.equal(gate.push(0.5, 0), null)
  assert.equal(gate.push(0.5, 1500), null)
  assert.equal(gate.push(0.5, 2000), 'max-duration')
})

test('the seam itself admits the WAV this encoder produces', async (t) => {
  const home = process.env.USERPROFILE ?? process.env.HOME
  const wave = home === undefined ? undefined : join(home, '.dsh', 'profiles', 'web', 'node_modules',
    '@deepseek-ai', 'dsh-experimental-speech-to-text', 'lib', 'types', 'wave.js')
  if (wave === undefined || !existsSync(wave)) {
    t.skip('no installed DSH profile on this machine')
    return
  }
  const { validateWave } = await import(pathToFileURL(wave).href)
  const seconds = 2
  const samples = new Float32Array(seconds * 16000)
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 40) * 0.4
  const checked = validateWave(new Uint8Array(encodeWav(samples)), 120)
  assert.ok(Math.abs(checked - seconds) < 0.01, 'the seam should read back the duration we encoded')
})
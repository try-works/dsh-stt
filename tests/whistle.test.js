/**
 * Unit tests for the Whistle provider: output parsing, platform mapping, assets,
 * argv construction and provider assembly. Nothing here spawns the engine or
 * touches the network.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWhistleProvider } from '../src/providers/whistle/index.js'
import {
  createSpec,
  parse,
  platformDirectory,
  engineUrl,
  audioSecondsFromWavBytes,
  LANGUAGES,
  ENGINE_BYTES,
  MODEL_BYTES,
  TIMEOUT_MS,
} from '../src/providers/whistle/spec.js'

/** Output captured from needle.exe on this machine, without word timestamps. */
const PLAIN = '{"text":"Turn off the kitchen lights and set the thermestat to 21 degrees.","language":"en","ttft_ms":904.9,"decode_tps":13.2}'

/** The same engine invoked with --audio-word-timestamps. */
const WITH_WORDS = '{"text":"Turn off the kitchen lights and set the thermal stat to 21 degrees.","language":"en","words":[{"word":"Turn","start":0.16,"end":0.32,"probability":0.829}],"ttft_ms":573.8,"decode_tps":32.2}'

/** Length of the 4.685 s kitchen-lights recording used by the end-to-end test. */
const WAV_BYTES = 149966

/**
 * Wait for the preparation to settle on one phase.
 * @param preparation - the provider's preparation controller.
 * @param phase - the phase to wait for.
 * @returns whether the phase was reached within two seconds.
 */
async function waitForPhase(preparation, phase) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (preparation.snapshot().phase === phase) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

test('parse reads the single JSON line the engine prints', () => {
  const result = parse(PLAIN)
  assert.equal(result.text, 'Turn off the kitchen lights and set the thermestat to 21 degrees.')
  assert.equal(result.audioSeconds, undefined)
})

test('parse tolerates a trailing newline and word timestamps', () => {
  assert.equal(parse(WITH_WORDS + '\r\n').text, 'Turn off the kitchen lights and set the thermal stat to 21 degrees.')
})

test('parse ignores a log line printed before the result', () => {
  assert.equal(parse('loading model...\n' + PLAIN + '\n').text, parse(PLAIN).text)
})

test('parse takes audioSeconds from the WAV length when the JSON has no duration', () => {
  assert.equal(parse(PLAIN, WAV_BYTES).audioSeconds, (WAV_BYTES - 44) / 32000)
})

test('parse prefers a duration reported in the JSON', () => {
  assert.equal(parse('{"text":"hi","duration":3.5}', WAV_BYTES).audioSeconds, 3.5)
  assert.equal(parse('{"text":"hi","audio_seconds":2}', WAV_BYTES).audioSeconds, 2)
})

test('parse returns empty text for an empty transcript', () => {
  assert.equal(parse('{"text":"","language":"en"}').text, '')
  assert.equal(parse('{"language":"en"}').text, '')
})

test('parse rejects output that carries no JSON result', () => {
  assert.throws(() => parse(''), /no JSON result/)
  assert.throws(() => parse('needle.exe: cannot read input.wav (RIFF WAV)'), /no JSON result/)
})

test('audioSecondsFromWavBytes converts 16 kHz mono PCM16 lengths', () => {
  assert.equal(audioSecondsFromWavBytes(WAV_BYTES), 4.6850625)
  assert.equal(audioSecondsFromWavBytes(32044), 1)
  assert.equal(audioSecondsFromWavBytes(44), undefined)
  assert.equal(audioSecondsFromWavBytes(0), undefined)
  assert.equal(audioSecondsFromWavBytes(undefined), undefined)
})

test('platformDirectory maps every published platform', () => {
  assert.equal(platformDirectory('win32', 'x64'), 'windows-x86_64')
  assert.equal(platformDirectory('win32', 'arm64'), 'windows-arm64')
  assert.equal(platformDirectory('darwin', 'arm64'), 'macos-arm64')
  assert.equal(platformDirectory('linux', 'x64'), 'linux-x86_64')
  assert.equal(platformDirectory('linux', 'arm64'), 'linux-arm64')
})

test('platformDirectory fails loudly instead of guessing', () => {
  assert.throws(() => platformDirectory('darwin', 'x64'), /no engine binary for darwin-x64/)
  assert.throws(() => platformDirectory('sunos', 'sparc'), /supported platforms are/)
  assert.throws(() => platformDirectory('win32', 'ia32'), /win32-ia32/)
})

test('engineUrl names the platform directory inside the needle3 repository', () => {
  assert.equal(
    engineUrl('win32', 'x64'),
    'https://huggingface.co/Cactus-Compute/needle3/resolve/main/windows-x86_64/needle.exe',
  )
  assert.equal(
    engineUrl('darwin', 'arm64'),
    'https://huggingface.co/Cactus-Compute/needle3/resolve/main/macos-arm64/needle.exe',
  )
  assert.throws(() => engineUrl('aix', 'ppc64'), /no engine binary/)
})

test('info advertises the model, its languages and its estimates', () => {
  const info = createSpec({ modelRoot: join('C:', 'models', 'whistle') }).info({ id: 'whistle' })
  assert.equal(info.id, 'whistle')
  assert.equal(info.name, 'Whistle (Cactus Compute)')
  assert.equal(info.location, 'host-local')
  assert.deepEqual(info.languages, ['auto', 'en', 'de', 'fr', 'es', 'it', 'nl', 'pl'])
  assert.deepEqual(info.downloadSources, ['https://huggingface.co', 'https://hf-mirror.com'])
  assert.deepEqual(info.setupEstimate, {
    recommendedDiskBytes: 26214400,
    expectedMemoryBytes: 262144000,
    minimumMinutes: 0,
    maximumMinutes: 2,
  })
  assert.equal(TIMEOUT_MS, 120000)
})

test('info honours a display-name override', () => {
  assert.equal(createSpec({ modelRoot: '.' }).info({ name: 'Local Whistle' }).name, 'Local Whistle')
})

test('info adopts the model root from the config the kit resolves', () => {
  const spec = createSpec()
  assert.throws(() => spec.assets(), /modelRoot/)
  spec.info({ id: 'whistle', modelRoot: join('C:', 'models') })
  assert.equal(spec.assets()[0].path, join('C:', 'models', 'needle.exe'))
})

test('assets lists the engine and the model under the model root', () => {
  const root = join('D:', 'models', 'whistle')
  const assets = createSpec({ modelRoot: root }).assets()
  assert.deepEqual(assets.map((asset) => asset.key), ['engine', 'model'])
  assert.equal(assets[0].path, join(root, 'needle.exe'))
  assert.equal(assets[0].bytes, ENGINE_BYTES)
  assert.equal(assets[0].url, 'https://huggingface.co/Cactus-Compute/needle3/resolve/main/windows-x86_64/needle.exe')
  assert.equal(assets[1].path, join(root, 'whistle.cact'))
  assert.equal(assets[1].bytes, MODEL_BYTES)
  assert.equal(assets[1].url, 'https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact')
})

test('assets honours a chosen download origin', () => {
  const assets = createSpec({ modelRoot: join('C:', 'models') }).assets('https://hf-mirror.com')
  assert.equal(assets[0].url, 'https://hf-mirror.com/Cactus-Compute/needle3/resolve/main/windows-x86_64/needle.exe')
  assert.equal(assets[1].url, 'https://hf-mirror.com/Cactus-Compute/whistle/resolve/main/whistle.cact')
})

test('assets fails loudly on a platform with no published engine', () => {
  const spec = createSpec({ modelRoot: join('C:', 'models') })
  assert.throws(() => spec.assets(undefined, 'darwin', 'x64'), /no engine binary for darwin-x64/)
})

test('command passes the model and the staged WAV to the engine', () => {
  const spec = createSpec({ modelRoot: join('C:', 'models') })
  const invocation = spec.command({ modelRoot: join('C:', 'models'), wavPath: join('C:', 'tmp', 'input.wav'), language: 'auto' })
  assert.equal(invocation.file, join('C:', 'models', 'needle.exe'))
  assert.deepEqual(invocation.args, [
    '--model', join('C:', 'models', 'whistle.cact'),
    '--audio', join('C:', 'tmp', 'input.wav'),
  ])
})

test('command forces a language the engine knows and detects otherwise', () => {
  const spec = createSpec({ modelRoot: join('C:', 'models') })
  const argsFor = (language) => spec.command({ modelRoot: join('C:', 'models'), wavPath: 'in.wav', language }).args
  assert.deepEqual(argsFor('en').slice(-2), ['--audio-language', 'en'])
  assert.deepEqual(argsFor('PL').slice(-2), ['--audio-language', 'pl'])
  assert.equal(argsFor('auto').includes('--audio-language'), false)
  assert.equal(argsFor(undefined).includes('--audio-language'), false)
  assert.equal(argsFor('').includes('--audio-language'), false)
  assert.equal(argsFor('zh').includes('--audio-language'), false)
  assert.equal(LANGUAGES.includes('auto'), true)
})

test('createWhistleProvider assembles info, preparation and a disposable engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whistle-unit-'))
  try {
    const provider = createWhistleProvider({ id: 'whistle', modelRoot: root })
    assert.equal(provider.info.id, 'whistle')
    assert.equal(provider.info.location, 'host-local')
    assert.equal(typeof provider.preparation.snapshot, 'function')
    assert.equal(typeof provider.dispose, 'function')
    // Nothing is on disk in an empty model root, so the disk-only inspection says so.
    assert.equal(await waitForPhase(provider.preparation, 'unprepared'), true)
    provider.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createWhistleProvider reports standby when both files are already present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whistle-ready-'))
  try {
    await writeFile(join(root, 'needle.exe'), Buffer.alloc(ENGINE_BYTES))
    await writeFile(join(root, 'whistle.cact'), Buffer.alloc(MODEL_BYTES))
    const provider = createWhistleProvider({ id: 'whistle', modelRoot: root })
    assert.equal(await waitForPhase(provider.preparation, 'standby'), true)
    provider.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('transcribe fails loudly when no model root is configured', async () => {
  const provider = createWhistleProvider({ id: 'whistle' })
  await assert.rejects(
    provider.transcribe({ audio: new Uint8Array(32044), language: 'auto' }, new AbortController().signal),
    /modelRoot/,
  )
  provider.dispose()
})

/**
 * End-to-end tests for the Whistle provider.
 *
 * These run the real engine binary over the kitchen-lights recording through the
 * whole stack: preparation inspection, WAV staging, argv construction, process
 * spawn, stdout parsing and the transcript shape the seam receives.
 *
 * The scratch assets live outside the package, so the suite skips cleanly wherever
 * they are absent, and DSH_STT_WHISTLE_MODEL_ROOT can point at another copy.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createWhistleProvider } from '../src/providers/whistle/index.js'
import { ENGINE_BYTES, MAX_AUDIO_SECONDS, MODEL_BYTES } from '../src/providers/whistle/spec.js'
import { BYTES_PER_SECOND, canonicalWav, parseWav } from '../src/provider-kit/audio.js'

/** Repository root, derived from this file so the working directory does not matter. */
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where the measured engine, model and sample recording were placed by hand. */
const MODEL_ROOT = process.env.DSH_STT_WHISTLE_MODEL_ROOT ?? join(PROJECT_ROOT, '_scratch', 'whistle')

/**
 * Find the kitchen-lights recording in the scratch directory.
 * @returns the absolute WAV path, or undefined when no candidate exists.
 */
function findKitchenWav() {
  const preferred = join(MODEL_ROOT, 'test16k.wav')
  if (existsSync(preferred)) return preferred
  let names = []
  try {
    names = readdirSync(MODEL_ROOT)
  } catch {
    return undefined
  }
  const wavs = names.filter((name) => name.toLowerCase().endsWith('.wav')).sort()
  const kitchen = wavs.find((name) => /kitchen/i.test(name))
  const chosen = kitchen ?? wavs[0]
  return chosen === undefined ? undefined : join(MODEL_ROOT, chosen)
}

/**
 * Check one scratch asset, by name and exact published size.
 * @param path - the absolute path to check.
 * @param bytes - the expected byte length.
 * @returns the reason it is unusable, or undefined when it is ready.
 */
function assetProblem(path, bytes) {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return path
  }
  return size === bytes ? undefined : path + ' has ' + size + ' bytes, expected ' + bytes
}

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

const WAV_PATH = findKitchenWav()
const PROBLEMS = [
  assetProblem(join(MODEL_ROOT, 'needle.exe'), ENGINE_BYTES),
  assetProblem(join(MODEL_ROOT, 'whistle.cact'), MODEL_BYTES),
  WAV_PATH === undefined ? 'no kitchen-lights WAV in ' + MODEL_ROOT : undefined,
].filter((problem) => problem !== undefined)

/** False when every scratch asset is present, otherwise the reason the suite is skipped. */
const SKIP = PROBLEMS.length === 0 ? false : 'scratch assets unavailable: ' + PROBLEMS.join('; ')

test('the real engine transcribes the kitchen-lights recording', { skip: SKIP }, async () => {
  const provider = createWhistleProvider({ id: 'whistle', modelRoot: MODEL_ROOT })
  try {
    assert.equal(await waitForPhase(provider.preparation, 'standby'), true, 'both assets should verify from disk')
    const phases = []
    const unsubscribe = provider.preparation.subscribe(() => { phases.push(provider.preparation.snapshot().phase) })
    const audio = await readFile(WAV_PATH)
    const result = await provider.transcribe({ audio, language: 'auto' }, new AbortController().signal)
    unsubscribe()

    assert.match(result.text.toLowerCase(), /kitchen/)
    assert.match(result.text.toLowerCase(), /lights/)
    assert.equal(result.audioSeconds, (audio.length - 44) / 32000)
    assert.ok(result.inferenceSeconds > 0, 'inference time should be measured')
    // A one-shot engine has no warm recognizer to wake, so the phase must NOT move
    // during a request: the shipping UI renders 'waking' as "Waking..." for its whole
    // duration, which would label every ordinary transcription as a wake-up.
    assert.ok(!phases.includes('waking'), 'a one-shot request must not report a wake-up')
    assert.equal(provider.preparation.snapshot().phase, 'standby')
  } finally {
    provider.dispose()
  }
})

test('a recording past the engine cap is segmented and joined', { skip: SKIP }, async () => {
  const provider = createWhistleProvider({ id: 'whistle', modelRoot: MODEL_ROOT })
  try {
    // The engine refuses more than 30 s outright, so this recording can only succeed
    // if the adapter cut it into segments and joined the transcripts.
    const seconds = 45
    const source = parseWav(await readFile(WAV_PATH))
    const pcm = Buffer.alloc(seconds * BYTES_PER_SECOND)
    for (let at = 0; at < pcm.length; at += source.data.length) source.data.copy(pcm, at)
    const audio = canonicalWav(pcm)
    assert.ok(audio.length - 44 > MAX_AUDIO_SECONDS * BYTES_PER_SECOND, 'the fixture must exceed the cap')

    const result = await provider.transcribe({ audio, language: 'auto' }, new AbortController().signal)
    assert.equal(result.audioSeconds, seconds, 'duration covers the whole recording, not one segment')
    assert.match(result.text.toLowerCase(), /kitchen/, 'the first segment must survive the join')
    // Roughly six repetitions fit in 45 s; more than one proves the segments were joined.
    const hits = result.text.toLowerCase().split('kitchen').length - 1
    assert.ok(hits >= 5, 'every segment should contribute, saw ' + hits)
    assert.equal(provider.preparation.snapshot().phase, 'standby')
  } finally {
    provider.dispose()
  }
})

test('the real engine accepts an explicit language hint', { skip: SKIP }, async () => {
  const provider = createWhistleProvider({ id: 'whistle', modelRoot: MODEL_ROOT })
  try {
    const audio = await readFile(WAV_PATH)
    const result = await provider.transcribe({ audio, language: 'en' }, new AbortController().signal)
    assert.match(result.text.toLowerCase(), /kitchen/)
    assert.match(result.text.toLowerCase(), /lights/)
  } finally {
    provider.dispose()
  }
})

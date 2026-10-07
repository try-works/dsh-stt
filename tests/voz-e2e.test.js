/**
 * The real thing: one recording transcribed by Voz through the whole provider
 * stack - preparation, warm worker child, JSON protocol, transcript.
 *
 * It skips, with a reason, unless this machine can run it: all six bundle files
 * complete on disk, a probe recording to transcribe, and the two model packages
 * resolvable from this checkout. Nothing here downloads anything.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPreparation } from '../src/provider-kit/preparation.js'
import { createWorkerProvider } from '../src/provider-kit/worker.js'
import { ASSETS, IDLE_TIMEOUT_MS, TIMEOUT_MS, createSpec, resolveLayout } from '../src/providers/voz/spec.js'

/** What the probe recording says, and how long it lasts. */
const EXPECTED = 'The quick brown fox jumps over the lazy dog. Speech recognition converts spoken words into written text.'
const RECORDING_SECONDS = 7.62

/**
 * The fixture that takes the network away from the worker child: the kit passes
 * NODE_OPTIONS on to it, so a fetch would fail the test rather than download.
 */
const NO_NETWORK = new URL('./no-network.mjs', import.meta.url).href

/** Recordings to try: the override first, then the two probe locations. */
const RECORDINGS = [
  process.env.DSH_STT_VOZ_TEST_WAV,
  'D:\\tmp\\speech.wav',
  'D:\\tmp\\vozprobe\\speech.wav',
  'E:\\tmp\\vozprobe\\speech.wav',
].filter((path) => typeof path === 'string' && path !== '')

/**
 * How the worker should resolve @desert-ant-labs/voz and onnxruntime-node.
 * @returns a node_modules root, undefined to resolve them by name, or null when neither works.
 */
function moduleRoot() {
  const configured = process.env.DSH_STT_VOZ_MODULE_ROOT
  if (configured !== undefined && configured !== '') return configured
  const require = createRequire(import.meta.url)
  try {
    require.resolve('@desert-ant-labs/voz')
    require.resolve('onnxruntime-node')
    return undefined
  } catch {
    return null
  }
}

/**
 * Why the end-to-end transcription cannot run here.
 * @returns the reason to skip, or null when every prerequisite is present.
 */
function skipReason() {
  const { modelRoot } = resolveLayout({})
  const incomplete = ASSETS.filter((asset) => {
    try {
      return statSync(join(modelRoot, asset.key)).size !== asset.bytes
    } catch {
      return true
    }
  })
  if (incomplete.length > 0) {
    return `the Voz bundle is not downloaded in ${modelRoot} (${incomplete.map((asset) => asset.key).join(', ')})`
  }
  if (RECORDINGS.every((path) => !existsSync(path))) {
    return `no probe recording to transcribe (looked for ${RECORDINGS.join(', ')})`
  }
  if (moduleRoot() === null) {
    return 'neither @desert-ant-labs/voz nor onnxruntime-node resolves from this checkout '
      + '(run npm install, or set DSH_STT_VOZ_MODULE_ROOT to a node_modules directory that has them)'
  }
  return null
}

test('transcribes a real recording, cold and then warm', { timeout: 300000, skip: skipReason() ?? false }, async () => {
  const recording = RECORDINGS.find((path) => existsSync(path))
  // Deliberately the file directory rather than a cache root: the worker still has
  // to be told which root Voz's own lookup reads, and this is that branch.
  const config = { modelRoot: resolveLayout({}).modelRoot }
  const spec = createSpec(config)

  const preparation = createPreparation({ assets: (source) => spec.assets(source) })
  assert.deepEqual(preparation.snapshot(), { phase: 'unprepared' })
  await preparation.inspect()
  // Disk only: the bundle is there, and nothing has been loaded.
  assert.deepEqual(preparation.snapshot(), { phase: 'standby' })

  const provider = createWorkerProvider({ spec, config, preparation, timeoutMs: TIMEOUT_MS, idleTimeoutMs: IDLE_TIMEOUT_MS })
  const inherited = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `${inherited ?? ''} --import=${NO_NETWORK}`.trim()
  try {
    const audio = new Uint8Array(readFileSync(recording))
    const { signal } = new AbortController()

    // From here the child has no fetch: the only way this can pass is by reading
    // the bundle preparation put on disk.
    const cold = await provider.transcribe({ audio, language: 'en' }, signal)
    assert.equal(cold.text.trim().replace(/\s+/g, ' '), EXPECTED)
    assert.ok(Math.abs(cold.audioSeconds - RECORDING_SECONDS) < 0.1, `audioSeconds was ${cold.audioSeconds}`)
    // The library's own download takes ~15 minutes on this link, so a plausible
    // number here is also the proof that the prepared files were adopted.
    assert.ok(cold.inferenceSeconds < 60, `the cold request took ${cold.inferenceSeconds}s, which means it downloaded the bundle`)
    assert.deepEqual(preparation.snapshot(), { phase: 'ready' })

    const warm = await provider.transcribe({ audio, language: 'en' }, signal)
    assert.equal(warm.text, cold.text)
    assert.ok(
      warm.inferenceSeconds < cold.inferenceSeconds,
      `the warm request must skip the 6.2 s load (${warm.inferenceSeconds}s against ${cold.inferenceSeconds}s)`,
    )
    console.log(`voz e2e: cold ${cold.inferenceSeconds}s, warm ${warm.inferenceSeconds}s -> ${cold.text}`)
  } finally {
    if (inherited === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = inherited
    provider.dispose()
    preparation.dispose()
  }
})

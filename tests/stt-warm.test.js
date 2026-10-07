/**
 * Preparation warms the recognizer, so the wait lands while the user is speaking.
 *
 * A stub worker stands in for a real engine: the point is the chain, not the model -
 * prepare() must reach the child, ask it to load, and leave the provider reporting
 * ready, which is what makes the microphone usable before any audio exists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreparation } from '../src/provider-kit/preparation.js'
import { createWorkerProvider } from '../src/provider-kit/worker.js'

/** A child that announces itself, records every op, and answers load or transcribe. */
const WORKER_SOURCE = [
  "import { createInterface } from 'node:readline'",
  "process.stdout.write(JSON.stringify({ event: 'started' }) + '\\n')",
  "const lines = createInterface({ input: process.stdin })",
  "lines.on('line', (line) => {",
  "  const message = JSON.parse(line)",
  "  if (message.op === 'load') {",
  "    process.stdout.write(JSON.stringify({ id: message.id, ok: true }) + '\\n')",
  "    return",
  "  }",
  "  process.stdout.write(JSON.stringify({ id: message.id, ok: true, text: 'probe', audioSeconds: 1 }) + '\\n')",
  "})",
].join('\n')

async function waitFor(preparation, phase, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (preparation.snapshot().phase === phase) return true
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
  return false
}

test('prepare() loads the recognizer and reports ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stt-warm-'))
  const workerEntry = join(root, 'worker.mjs')
  await writeFile(workerEntry, WORKER_SOURCE)
  const assetPath = join(root, 'model.bin')
  await writeFile(assetPath, Buffer.alloc(4))
  const spec = {
    name: 'Probe',
    info: () => ({ id: 'probe', name: 'Probe', location: 'host-local', languages: ['en'] }),
    assets: () => [{ key: 'model', url: 'http://127.0.0.1:9/model.bin', path: assetPath, bytes: 4 }],
    workerEntry,
    workerEnv: () => ({}),
  }
  let engine = null
  const preparation = createPreparation({
    assets: (source) => spec.assets(source),
    warm: async () => { await engine?.warm() },
  })
  engine = createWorkerProvider({ spec, config: {}, preparation, timeoutMs: 10000, idleTimeoutMs: 0 })
  try {
    await preparation.inspect()
    assert.equal(preparation.snapshot().phase, 'standby', 'a complete bundle rests at standby')
    preparation.prepare()
    assert.equal(await waitFor(preparation, 'ready'), true, 'prepare() should leave the model resident')
  } finally {
    engine.dispose()
    preparation.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('warming twice does not reload the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stt-warm2-'))
  const workerEntry = join(root, 'worker.mjs')
  await writeFile(workerEntry, WORKER_SOURCE)
  const assetPath = join(root, 'model.bin')
  await writeFile(assetPath, Buffer.alloc(4))
  const spec = {
    name: 'Probe',
    info: () => ({ id: 'probe', name: 'Probe', location: 'host-local', languages: ['en'] }),
    assets: () => [{ key: 'model', url: 'http://127.0.0.1:9/model.bin', path: assetPath, bytes: 4 }],
    workerEntry,
    workerEnv: () => ({}),
  }
  let engine = null
  const preparation = createPreparation({
    assets: (source) => spec.assets(source),
    warm: async () => { await engine?.warm() },
  })
  engine = createWorkerProvider({ spec, config: {}, preparation, timeoutMs: 10000, idleTimeoutMs: 0 })
  try {
    await engine.warm()
    const child = engine.warm()
    await child
    assert.equal(preparation.snapshot().phase, 'ready')
  } finally {
    engine.dispose()
    preparation.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

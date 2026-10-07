/**
 * Protocol tests for the Voz worker child.
 *
 * These need neither the model nor onnxruntime: the child is pointed at an empty
 * model directory, which is exactly the state a user is in before preparing the
 * model. That makes them the check that the child still announces readiness at
 * once and refuses to begin the library's own un-resumable download.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { WORKER_ENTRY } from '../src/providers/voz/spec.js'

/**
 * Spawn the worker against one model directory and collect its JSON lines.
 * @param modelDirectory - the directory the child must look for the bundle in.
 * @returns the child, the messages received, and send/await/stop handles.
 */
function startWorker(modelDirectory) {
  const child = spawn(process.execPath, [WORKER_ENTRY], {
    env: { ...process.env, DSH_STT_VOZ_MODEL_ROOT: modelDirectory },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  const received = []
  const listeners = new Set()
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      message = { raw: line }
    }
    received.push(message)
    for (const listener of [...listeners]) listener(message)
  })
  /**
   * Await the first message - already received or still to come - that matches.
   * @param predicate - the test for one message.
   * @param timeoutMs - how long to wait before failing the test.
   * @returns the matching message.
   */
  const next = (predicate, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const arrived = received.find(predicate)
    if (arrived !== undefined) {
      resolve(arrived)
      return
    }
    const timer = setTimeout(() => {
      listeners.delete(listener)
      reject(new Error('the worker sent no matching message'))
    }, timeoutMs)
    const listener = (message) => {
      if (!predicate(message)) return
      clearTimeout(timer)
      listeners.delete(listener)
      resolve(message)
    }
    listeners.add(listener)
  })
  return {
    child,
    received,
    next,
    send: (message) => child.stdin.write(JSON.stringify(message) + '\n'),
    stop: () => {
      lines.close()
      child.kill()
    },
  }
}

/**
 * Start a worker on an empty model directory and wait for its readiness line.
 * @param t - the running test, which owns the cleanup.
 * @returns the worker and the empty directory it was pointed at.
 */
async function startEmptyWorker(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stt-voz-empty-'))
  const worker = startWorker(directory)
  t.after(async () => {
    worker.stop()
    await rm(directory, { recursive: true, force: true })
  })
  await worker.next((message) => message.event === 'started', 10000)
  return { worker, directory }
}

test('announces itself at once and loads nothing until asked', async (t) => {
  const started = Date.now()
  const { worker } = await startEmptyWorker(t)
  const elapsed = Date.now() - started
  assert.deepEqual(worker.received, [{ event: 'started' }])
  assert.ok(elapsed < 6000, `readiness took ${elapsed} ms, but the model load alone is 6.2 s`)
  assert.equal(worker.child.exitCode, null)
})

test('refuses to transcribe a bundle that was never downloaded', async (t) => {
  const { worker, directory } = await startEmptyWorker(t)
  worker.send({ id: 7, op: 'transcribe', wavPath: join(directory, 'missing.wav'), language: 'en' })
  const reply = await worker.next((message) => message.id === 7)
  assert.equal(reply.ok, false)
  assert.match(reply.error, /missing or incomplete/)
  assert.match(reply.error, /meta\.json/)
  assert.match(reply.error, /Prepare the model/)
  // Still alive: it reported instead of starting a download and dying.
  assert.equal(worker.child.exitCode, null)
})

test('answers an unknown op instead of hanging', async (t) => {
  const { worker } = await startEmptyWorker(t)
  worker.send({ id: 3, op: 'shutdown' })
  const reply = await worker.next((message) => message.id === 3)
  assert.deepEqual(reply, { id: 3, ok: false, error: 'unsupported op shutdown' })
})

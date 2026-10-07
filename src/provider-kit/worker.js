/** Provider factory for engines kept warm in a long-lived child process. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One child process running a model, with a serialized JSON-lines protocol.
 *
 * The engine may be process-global and non-thread-safe, so requests are strictly
 * serialized; a crash rejects the in-flight request and leaves the host intact.
 */
class Worker {
  constructor({ entry, env, logger, onExit }) {
    this.entry = entry
    this.env = env
    this.logger = logger
    this.onExit = onExit
    this.child = null
    this.pending = null
    this.nextId = 1
    this.started = null
  }

  /** Spawn the child if it is not already alive. */
  async start() {
    if (this.child !== null) return
    if (this.started !== null) return await this.started
    this.started = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.entry], {
        env: { ...process.env, ...this.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => { this.receive(line) })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { this.logger?.debug?.('worker: ' + chunk.trim()) })
      child.on('error', (error) => { reject(error) })
      child.on('close', (code) => {
        this.child = null
        this.started = null
        const pending = this.pending
        this.pending = null
        pending?.reject(new Error('the recognition worker exited with code ' + code))
        this.onExit?.()
      })
      const ready = (line) => {
        if (line.includes('"event":"started"')) {
          lines.off('line', ready)
          resolve()
        }
      }
      lines.on('line', ready)
    })
    return await this.started
  }

  receive(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.logger?.debug?.('worker emitted a non-JSON line: ' + line)
      return
    }
    const pending = this.pending
    if (pending === null || message.id !== pending.id) return
    this.pending = null
    clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message)
    else pending.reject(new Error(message.error ?? 'the recognition worker failed'))
  }

  send(op, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending = null
        this.stop()
        reject(new Error('inference exceeded ' + timeoutMs + ' ms'))
      }, timeoutMs)
      this.pending = { id, resolve, reject, timer }
      this.child.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n')
    })
  }

  /** Terminate the child and reject anything in flight. */
  stop() {
    const child = this.child
    this.child = null
    this.started = null
    const pending = this.pending
    this.pending = null
    if (pending !== null) {
      clearTimeout(pending.timer)
      pending.reject(new Error('the recognition worker was stopped'))
    }
    try {
      child?.kill()
    } catch {
      // The child already exited.
    }
  }
}

/**
 * Build a provider whose engine is kept warm between recordings.
 *
 * The model load is expensive enough to amortize (measured at 6.2 s for Voz), so
 * the child persists until an idle deadline and releases roughly a gigabyte of
 * resident weights when it goes.
 *
 * @param options - the model spec, resolved config, preparation and limits.
 * @returns a SpeechProvider.
 */
export function createWorkerProvider({ spec, config, preparation, logger, timeoutMs, idleTimeoutMs }) {
  let idle = null
  let chain = Promise.resolve()
  /** True once the child holds a loaded model, not merely a running process. */
  let resident = false
  const worker = new Worker({
    entry: spec.workerEntry,
    env: spec.workerEnv(config),
    logger,
    onExit: () => {
      clearTimeout(idle)
      idle = null
      resident = false
      preparation.markCold()
    },
  })

  const touch = () => {
    clearTimeout(idle)
    if (idleTimeoutMs <= 0) return
    idle = setTimeout(() => { worker.stop() }, idleTimeoutMs)
    idle.unref?.()
  }

  return {
    info: spec.info(config),
    preparation,
    async transcribe(input, signal) {
      signal.throwIfAborted()
      const staged = await mkdtemp(join(tmpdir(), 'dsh-stt-'))
      const wavPath = join(staged, 'input.wav')
      await writeFile(wavPath, input.audio)
      const started = Date.now()
      // Serialize: the engine holds one process-global model.
      const run = chain.then(async () => {
        signal.throwIfAborted()
        if (!resident) preparation.markWaking()
        await worker.start()
        touch()
        const result = await worker.send('transcribe', { wavPath, language: input.language }, timeoutMs)
        // 'ready' means the model is loaded, not merely that the process is up.
        resident = true
        preparation.markReady()
        return result
      })
      chain = run.then(() => {}, () => {})
      try {
        const result = await run
        return {
          text: result.text ?? '',
          audioSeconds: result.audioSeconds ?? (input.audio.length - 44) / 32000,
          inferenceSeconds: (Date.now() - started) / 1000,
        }
      } finally {
        await rm(staged, { recursive: true, force: true }).catch(() => {})
        touch()
      }
    },
    /**
     * Load the recognizer now instead of on the next request.
     *
     * A caller invokes this when the user starts speaking, so the seconds a cold model
     * costs are spent while audio is still being captured rather than after the
     * recording has already finished.
     *
     * @returns after the model is resident, or immediately if it already is.
     */
    async warm() {
      if (worker.child !== null && resident) return
      const load = chain.then(async () => {
        await worker.start()
        touch()
        if (resident) return
        await worker.send('load', {}, timeoutMs)
        resident = true
        preparation.markReady()
        touch()
      })
      chain = load.then(() => {}, () => {})
      await load
    },

    /** Release the child; the provider is being unregistered. */
    dispose() {
      clearTimeout(idle)
      worker.stop()
    },
  }
}

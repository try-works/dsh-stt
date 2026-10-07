/** One provider's resource preparation: disk inspection, resumable download, and the state the seam renders. */
import { downloadAsset, isComplete, applySource } from './http.js'

/**
 * Classify a download failure into the seam's vocabulary.
 * @param error - the thrown error.
 * @returns the safe reason and optional HTTP status.
 */
export function classify(error) {
  // A fetch failure carries message 'fetch failed' and the real diagnosis on
  // error.cause, so read the whole cause chain rather than the top message.
  const parts = []
  let current = error
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if (typeof current !== 'object') break
    for (const field of ['message', 'code', 'errno']) {
      const value = current[field]
      if (typeof value === 'string' && value !== '') parts.push(value)
    }
    current = current.cause
  }
  const text = parts.join(' ')
  const status = /HTTP (\d{3})/.exec(text)
  if (status !== null) return { reason: 'http', status: Number(status[1]) }
  if (/expected \d+ bytes/.test(text)) return { reason: 'integrity' }
  if (/ENOSPC|EACCES|EPERM|EROFS|ENOTDIR/.test(text)) return { reason: 'storage' }
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(text)) return { reason: 'certificate' }
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return { reason: 'dns' }
  if (/TIMEOUT|ETIMEDOUT|terminated|ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR|fetch failed/i.test(text)) {
    return { reason: 'network' }
  }
  return { reason: 'unknown' }
}

/**
 * Build one provider's preparation controller.
 *
 * The registry treats a provider with no `preparation` as permanently ready, so a
 * provider that downloads on demand must supply one -- otherwise the first
 * transcription would silently fetch the model instead of the UI offering it.
 *
 * @param options - the provider's asset list, optional warm-up, and logging.
 * @returns the SpeechPreparation shape plus readiness hooks the provider drives.
 */
export function createPreparation({ assets, warm, logger, now = Date.now }) {
  let state = { phase: 'unprepared' }
  let task = null
  let controller = null
  let disposed = false
  const listeners = new Set()

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        logger?.warn?.('preparation listener failed: ' + String(error))
      }
    }
  }
  const set = (next) => {
    state = next
    notify()
  }

  /** Resolve every asset for a chosen origin. */
  const listAssets = (source) => assets(source).map((asset) => ({ ...asset, url: applySource(asset.url, source) }))

  /**
   * Read disk only; never fetches. Called at activation and after a failure.
   * @returns after the readiness snapshot is published.
   */
  async function inspect() {
    if (disposed || task !== null) return
    const list = listAssets(undefined)
    const checks = await Promise.all(list.map((asset) => isComplete(asset.path, asset.bytes)))
    if (disposed) return
    set(checks.every(Boolean) ? { phase: 'standby' } : { phase: 'unprepared' })
  }

  /** The recognizer is warm and can transcribe without a load. */
  function markReady() {
    if (disposed || task !== null) return
    set({ phase: 'ready' })
  }

  /** The warm recognizer was released, by idle reclamation or a crash. */
  function markCold() {
    if (disposed || task !== null) return
    set({ phase: 'standby' })
  }

  /** A request is loading a cold recognizer. */
  function markWaking() {
    if (disposed || task !== null) return
    set({ phase: 'waking', startedAt: now() })
  }

  async function verify(list) {
    for (const asset of list) {
      if (!(await isComplete(asset.path, asset.bytes))) throw new Error(asset.key + ' failed verification')
    }
  }

  /**
   * Start or join the download task.
   * @param options - a task-local download origin chosen by the user.
   * @returns nothing; the task publishes its own progress.
   */
  function prepare(options) {
    if (disposed || task !== null) return
    controller = new AbortController()
    task = run(options)
      .catch((error) => { logger?.warn?.('preparation failed: ' + String(error)) })
      .finally(() => {
        task = null
        controller = null
      })
  }

  async function run(options) {
    const source = options?.downloadSource
    const list = listAssets(source)
    const totalBytes = list.reduce((sum, asset) => sum + asset.bytes, 0)
    const steps = [
      { kind: 'check', status: 'running', startedAt: now() },
      { kind: 'model', status: 'pending' },
      { kind: 'verify', status: 'pending' },
      ...(warm === undefined ? [] : [{ kind: 'load', status: 'pending' }]),
    ]
    set({ phase: 'checking', startedAt: now(), step: 'check', steps })

    let completed = 0
    let lastPublished = 0
    const publish = (resource, done, force) => {
      const at = now()
      if (!force && at - lastPublished < 100) return
      lastPublished = at
      set({ phase: 'downloading', resource, completedBytes: completed + done, totalBytes, step: 'model', steps })
    }

    try {
      steps[0].status = 'complete'
      steps[1].status = 'running'
      for (const asset of list) {
        publish(asset.key, 0, true)
        await downloadAsset({
          url: asset.url,
          destination: asset.path,
          expectedBytes: asset.bytes,
          signal: controller.signal,
          onProgress: (done) => { publish(asset.key, done, false) },
        })
        completed += asset.bytes
        publish(asset.key, 0, true)
      }
      steps[1].status = 'complete'

      steps[2].status = 'running'
      set({ phase: 'checking', startedAt: now(), step: 'verify', steps })
      await verify(list)
      steps[2].status = 'complete'

      if (warm === undefined) {
        set({ phase: 'standby', steps })
        return
      }
      steps[3].status = 'running'
      set({ phase: 'loading', startedAt: now(), step: 'load', steps })
      await warm()
      steps[3].status = 'complete'
      set({ phase: 'ready', steps })
    } catch (error) {
      if (controller.signal.aborted) {
        for (const step of steps) if (step.status === 'running') step.status = 'cancelled'
        set({ phase: 'cancelled', steps })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      for (const step of steps) if (step.status === 'running') step.status = 'failed'
      set({
        phase: 'failed',
        message,
        step: steps.find((step) => step.status === 'failed')?.kind,
        steps,
        download: {
          resource: 'model',
          source: source ?? 'https://huggingface.co',
          ...classify(error),
        },
      })
    }
  }

  /**
   * Cancel the running preparation task and join its settlement.
   * @returns after the task stops.
   */
  async function cancel() {
    if (task === null) return
    set({ phase: 'cancelling', startedAt: now(), steps: state.steps })
    controller?.abort()
    await task
  }

  /** Release listeners; the owning provider is being unregistered. */
  function dispose() {
    disposed = true
    listeners.clear()
  }

  return {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    prepare,
    cancel,
    inspect,
    markReady,
    markCold,
    markWaking,
    dispose,
  }
}

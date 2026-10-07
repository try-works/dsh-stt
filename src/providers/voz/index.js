/**
 * Voz as a registered DSH speech provider.
 *
 * This module is the only place that knows the provider keeps one warm child
 * process: the model load costs about six seconds and a gigabyte, so the child
 * persists between recordings and is released on an idle deadline. Preparation
 * owns the download, because the package's own loader has no retry and no resume.
 */

import { createPreparation } from '../../provider-kit/preparation.js'
import { createWorkerProvider } from '../../provider-kit/worker.js'
import { createSpec } from './spec.js'

export * from './spec.js'

/**
 * Build the Voz provider: a warm worker over a resumably downloaded bundle.
 *
 * The bundle is fetched by the preparation step rather than by the package, so the
 * child always loads from disk; the worker refuses an incomplete bundle instead of
 * letting the package start its own un-retried 349 MB transfer.
 *
 * @param config - the resolved provider config; modelRoot is required, id and name optional.
 * @param options - optional collaborators, currently just a logger.
 * @returns a SpeechProvider plus a dispose() that releases the child and listeners.
 */
export function createVozProvider(config = {}, options = {}) {
  const logger = options.logger
  const spec = createSpec(config)
  // The engine is created after the preparation that warms it, so the warm step
  // reads the engine through this holder rather than capturing it directly.
  let engine = null
  const preparation = createPreparation({
    assets: (source) => spec.assets(source),
    warm: async () => { await engine?.warm() },
    logger,
  })
  engine = createWorkerProvider({
    spec,
    config,
    preparation,
    logger,
    timeoutMs: spec.timeoutMs,
    idleTimeoutMs: spec.idleTimeoutMs,
  })

  // Disk only, once, at activation: the picker must not fetch anything on its own.
  const activated = Promise.resolve()
    .then(() => preparation.inspect())
    .catch((error) => {
      logger?.warn?.('voz inspection failed: ' + String(error))
    })

  return {
    info: engine.info,
    preparation,

    /**
     * Recognize one recording in the warm child.
     * @param input - WAV bytes and the language hint for this recording.
     * @param signal - cancellation for this request.
     * @returns the transcript, its audio duration and the measured inference time.
     */
    async transcribe(input, signal) {
      await activated
      return await engine.transcribe(input, signal)
    },

    /** Release the child and the preparation listeners; the provider is being unregistered. */
    dispose() {
      engine.dispose()
      preparation.dispose()
    },
  }
}

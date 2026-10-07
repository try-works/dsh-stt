/**
 * Whistle as a registered DSH speech provider.
 *
 * This module is the only place that knows the provider runs one process per
 * recording, so it is also the only place that can report that lifecycle to the
 * preparation seam: every request starts a cold engine and every exit returns the
 * model memory, which is exactly what markWaking() and markCold() describe.
 */

import { createPreparation } from '../../provider-kit/preparation.js'
import { createOneShotProvider } from '../../provider-kit/oneshot.js'
import { createSpec, TIMEOUT_MS } from './spec.js'

export { createSpec, parse, platformDirectory, engineUrl, audioSecondsFromWavBytes } from './spec.js'
export { LANGUAGES, DEFAULT_NAME, TIMEOUT_MS, PLATFORM_DIRECTORIES } from './spec.js'
export { ENGINE_FILE, MODEL_FILE, ENGINE_BYTES, MODEL_BYTES } from './spec.js'

/**
 * Build the Whistle provider: one-shot engine, lazy download, shared preparation seam.
 *
 * The engine needs no warm-up of its own, so the preparation has no warm step and
 * ends at standby once both files verify; the first transcription is the first load.
 *
 * @param config - the resolved provider config; modelRoot is required, id and name optional.
 * @param options - optional collaborators, currently just a logger.
 * @returns a SpeechProvider plus a dispose() that releases the preparation listeners.
 */
export function createWhistleProvider(config = {}, options = {}) {
  const logger = options.logger
  const spec = createSpec(config)
  const preparation = createPreparation({
    assets: (source) => spec.assets(source),
    logger,
  })
  const engine = createOneShotProvider({ spec, config, preparation, logger, timeoutMs: TIMEOUT_MS })

  // Disk only, once, at activation: the picker must not fetch anything on its own.
  const activated = Promise.resolve()
    .then(() => preparation.inspect())
    .catch((error) => {
      logger?.warn?.('whistle inspection failed: ' + String(error))
    })

  return {
    info: engine.info,
    preparation,

    /**
     * Recognize one recording in a process of its own.
     *
     * The phase deliberately stays at `standby` for the whole request. The engine is
     * cold before and after every call - there is no warm recognizer to wake - and
     * the shipping UI renders `waking` as "Waking..." for as long as it lasts, so
     * reporting it here labels every ordinary transcription as a wake-up. `standby`
     * is both the truthful state and the one that shows "Transcribing...".
     *
     * @param input - WAV bytes and the language hint for this recording.
     * @param signal - cancellation for this request.
     * @returns the transcript, its audio duration and the measured inference time.
     */
    async transcribe(input, signal) {
      await activated
      return await engine.transcribe(input, signal)
    },

    /** Release the preparation listeners; the provider is being unregistered. */
    dispose() {
      preparation.dispose()
    },
  }
}

export default createWhistleProvider

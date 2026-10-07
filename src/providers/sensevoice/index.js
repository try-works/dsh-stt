/**
 * SenseVoice as an advertised-but-absent model.
 *
 * DSH already ships a working SenseVoice provider. This module deliberately does
 * NOT wire it up: it registers the same provider id with a display name that says
 * so in the picker, downloads nothing, and never becomes usable. The seam has no
 * 'unavailable' phase, so `unprepared` is the truthful resting state and clicking
 * prepare explains rather than fetches.
 *
 * To hand over to the real implementation later, disable this provider and drop the
 * `speech-to-text-sensevoice: disabled` override in cordis.patch.yml. The id is
 * unchanged, so a saved selection carries across.
 */

/** Language hints the real recognizer accepts, so selecting it never throws. */
export const languages = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** Shown when a user asks for the model before it exists. */
export const COMING_SOON = 'SenseVoice is coming soon and cannot be downloaded yet.'

/**
 * Build the placeholder provider.
 * @param config - the resolved provider config (id and display name may be overridden).
 * @returns a SpeechProvider that advertises without downloading.
 */
export function createPlaceholderProvider(config) {
  let state = { phase: 'unprepared' }
  const listeners = new Set()
  const publish = (next) => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    info: {
      id: config.id,
      name: config.name ?? 'SenseVoice (coming soon)',
      location: 'host-local',
      languages,
    },
    preparation: {
      snapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      // Advertising, not preparing: say why instead of fetching anything.
      prepare: () => { publish({ phase: 'failed', message: COMING_SOON }) },
      cancel: async () => {
        if (state.phase === 'failed') publish({ phase: 'unprepared' })
      },
    },
    async transcribe() {
      throw new Error(COMING_SOON)
    },
  }
}

/** dsh-stt: multi-model local speech recognition, registered into the shipped speech seam. */
import { join } from 'node:path'
import { Config } from './config.js'
import { createWhistleProvider } from './providers/whistle/index.js'
import { createVozProvider } from './providers/voz/index.js'
import { createPlaceholderProvider } from './providers/sensevoice/index.js'

export { Config } from './config.js'

/** Cordis plugin name; also the default logger name. */
export const name = 'dsh-stt'

/** The shared registry this plugin contributes recognizers to. */
export const inject = ['speechToText']

/**
 * The built-in model roster.
 *
 * Each entry knows how to build its recognizer; the configuration only decides
 * whether it is registered and where its files live. Order is the picker's order.
 */
const MODELS = [
  {
    key: 'whistle-local',
    build: ({ config, logger }) => createWhistleProvider(config, { logger }),
  },
  {
    key: 'voz-local',
    build: ({ config, logger }) => createVozProvider(config, { logger }),
  },
  {
    key: 'sensevoice-local',
    // Advertised only: this one never downloads and never becomes usable (D13).
    build: ({ config }) => createPlaceholderProvider(config),
  },
]

/**
 * Register every enabled recognizer.
 *
 * Registration is a Cordis effect, so disabling the bundle, or editing the profile
 * patch at run time, unwinds each provider -- releasing its child process and its
 * preparation listeners -- without leaving a stray registration behind.
 *
 * Nothing is fetched here. A provider inspects disk only, and downloads when the
 * user chooses it in the picker and asks for it.
 *
 * @param ctx - Host context providing the speech registry and a logger.
 * @param config - validated plugin configuration.
 * @returns nothing.
 */
export function apply(ctx, config) {
  const logger = ctx.logger?.(name)
  for (const model of MODELS) {
    const chosen = config.providers?.[model.key] ?? {}
    if (chosen.enabled === false) {
      logger?.debug?.('provider disabled by configuration: ' + model.key)
      continue
    }
    const provider = model.build({
      config: {
        id: chosen.id ?? model.key,
        name: chosen.name,
        modelRoot: chosen.modelRoot ?? join(config.dataRoot, model.key),
      },
      logger,
    })
    ctx.effect(() => {
      const unregister = ctx.speechToText.register(provider)
      return async () => {
        provider.dispose?.()
        await unregister()
      }
    })
  }
}

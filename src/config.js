/** Validated deployment configuration for the dsh-stt provider set. */
import z from '@deepseek-ai/schemastery'

/** One model's overrides; every field is optional so a row can name just `enabled`. */
export const ProviderConfig = z.object({
  enabled: z.boolean().default(true),
  modelRoot: z.union([z.string().min(1), z.const(undefined)]),
  id: z.string().min(1),
  name: z.string().min(1),
})

/**
 * Deployment-varying choices, validated at activation.
 *
 * `providers` is keyed by the built-in model keys (whistle-local, voz-local,
 * sensevoice-local). A key that is absent keeps its built-in default, and
 * `enabled: false` stops that provider from being registered at all - which is the
 * strongest form of \"do not download it\", since an unregistered provider cannot be
 * listed, selected or fetched.
 */
export const Config = z.object({
  dataRoot: z.string().min(1).required(),
  providers: z.dict(ProviderConfig).default({}),
})

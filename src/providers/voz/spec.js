/**
 * Voz (Desert Ant Labs) as a dsh-stt model: what to download, where Voz looks
 * for it, and what its worker child needs.
 *
 * Voz is a 467 MB multilingual bundle - six files, 384,832,967 bytes on the Hub -
 * running on WebAssembly plus onnxruntime-node. Two measured properties decide
 * this adapter's shape:
 *
 * 1. `Voz.load({ cache: true })` fetches each file with one un-retried, un-resumable
 *    request, which failed on this link at 37.5% of the 349 MB encoder data file.
 *    Preparation therefore downloads the bundle itself through the kit's resumable
 *    downloader and places it exactly where Voz's own cache lookup looks
 *    (platform-node.js: `<root>/desert-ant-models/<repo>/<revision>/web/<file>`),
 *    after which `Voz.load` adopts the files through `fs.existsSync` and never
 *    touches the network.
 * 2. Loading costs 6.2 s and about 1 GB resident, so the engine runs in a warm
 *    worker child that is reclaimed on an idle deadline instead of per recording.
 *
 * The registry assembles the provider from this spec:
 *
 *     const spec = createSpec(config)
 *     const preparation = createPreparation({ assets: (source) => spec.assets(source), logger })
 *     const provider = createWorkerProvider({
 *       spec, config, preparation, logger,
 *       timeoutMs: spec.timeoutMs, idleTimeoutMs: spec.idleTimeoutMs,
 *     })
 */
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applySource } from '../../provider-kit/http.js'

/** The worker that holds the loaded model; an absolute path, as the kit requires. */
export const WORKER_ENTRY = fileURLToPath(new URL('./worker.js', import.meta.url))

/** One recording's deadline: the first request also pays the 6.2 s model load. */
export const TIMEOUT_MS = 180000

/** How long a loaded model may sit unused before the child is reclaimed. */
export const IDLE_TIMEOUT_MS = 300000

/** Where a bundle file is published, before any download origin is applied. */
export const HUB_BASE_URL = 'https://huggingface.co/desert-ant-labs/voz/resolve/main/web/'

/** Provider id used when the registry does not name one. */
const DEFAULT_ID = 'voz-local'

/** Display name: the engine is Voz, and on the host it is WASM on the CPU. */
const DEFAULT_NAME = 'Voz (Desert Ant Labs, WASM/CPU)'

/**
 * The 25 languages Voz recognizes.
 *
 * The bundle is multilingual and takes no language hint at run time, so this list
 * is the whole enforcement point: the picker offers exactly these codes, and
 * there is deliberately no 'auto', because Voz does not detect language and a
 * wrong code produces confident nonsense rather than an error.
 */
export const LANGUAGES = Object.freeze([
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu',
  'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk',
])

/**
 * The path Voz appends to the platform cache root, mirrored from platform-node.js
 * so our download lands where the library's own lookup expects it.
 */
export const CACHE_SEGMENTS = Object.freeze(['desert-ant-models', 'desert-ant-labs', 'voz', 'main', 'web'])

/**
 * The six published bundle files and their exact byte lengths.
 *
 * `key` is the published file name, the local file name and the label progress
 * reports the download under - one identifier, so a mismatch cannot hide.
 */
export const ASSETS = Object.freeze([
  Object.freeze({ key: 'meta.json', bytes: 539 }),
  Object.freeze({ key: 'vocab.json', bytes: 78654 }),
  Object.freeze({ key: 'embedding.f16', bytes: 10487040 }),
  Object.freeze({ key: 'encoder.onnx', bytes: 813056 }),
  Object.freeze({ key: 'encoder.onnx.data', bytes: 348981248 }),
  Object.freeze({ key: 'decoder.webgpu.onnx', bytes: 24472430 }),
])

/**
 * The path flavor of a platform, so an injected platform resolves paths the way
 * that machine would rather than the way this one does.
 * @param platform - a process.platform value.
 * @returns node:path's win32 implementation on Windows, posix elsewhere.
 */
function flavorOf(platform) {
  return platform === 'win32' ? win32 : posix
}

/**
 * The cache root Voz itself uses when DAL_CACHE_ROOT is unset.
 *
 * Mirrors platform-node.js exactly, including its use of '??' rather than '||':
 * an empty DAL_CACHE_ROOT is a root, not an absent one.
 *
 * @param options - injectable environment, platform and home directory.
 * @returns the absolute cache root for this platform.
 */
export function defaultCacheRoot({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.DAL_CACHE_ROOT !== undefined) return env.DAL_CACHE_ROOT
  if (platform === 'darwin') return flavorOf(platform).join(home, 'Library', 'Caches')
  return env.XDG_CACHE_HOME !== undefined ? env.XDG_CACHE_HOME : flavorOf(platform).join(home, '.cache')
}

/**
 * Whether a path already names the bundle directory rather than a cache root.
 * @param path - an absolute path to test.
 * @returns whether its last segments are the five Voz appends.
 */
function hasCacheLayout(path) {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length < CACHE_SEGMENTS.length) return false
  const tail = parts.slice(-CACHE_SEGMENTS.length)
  return tail.every((part, index) => part.toLowerCase() === CACHE_SEGMENTS[index])
}

/**
 * Resolve the two directories this provider works with.
 *
 * `config.modelRoot` overrides the platform default and may be written either way:
 * a directory that already ends in the cache layout is used verbatim, and any
 * other directory is treated as the cache root the layout is appended to. Both
 * spellings therefore end up with the worker reading exactly what preparation wrote.
 *
 * @param config - resolved provider config; `modelRoot` is the override.
 * @param options - injectable environment, platform and home directory.
 * @returns the cache root the worker receives and the directory holding the six files.
 */
export function resolveLayout(config = {}, options = {}) {
  const { env = process.env, platform = process.platform, home = homedir() } = options
  const paths = flavorOf(platform)
  const cacheRoot = defaultCacheRoot({ env, platform, home })
  const fallback = paths.join(cacheRoot, ...CACHE_SEGMENTS)
  const configured = config.modelRoot
  if (configured === undefined || configured === null || configured === '') {
    return { cacheRoot, modelRoot: fallback }
  }
  const chosen = paths.resolve(String(configured))
  if (!hasCacheLayout(chosen)) {
    return { cacheRoot: chosen, modelRoot: paths.join(chosen, ...CACHE_SEGMENTS) }
  }
  let root = chosen
  for (let step = 0; step < CACHE_SEGMENTS.length; step += 1) root = paths.dirname(root)
  return { cacheRoot: root, modelRoot: chosen }
}

/**
 * The six bundle files, resolved for one download origin and one model directory.
 *
 * Canonical URLs are rewritten onto `source` here and the kit rewrites them again
 * for the preparation task; rewriting an origin twice is a no-op, so both callers
 * get the origin they asked for.
 *
 * @param source - a chosen download origin, or undefined for the canonical one.
 * @param config - resolved provider config; `modelRoot` moves the directory.
 * @param options - injectable environment, platform and home directory.
 * @returns the kit's asset records, with absolute local paths.
 */
export function assets(source, config = {}, options = {}) {
  const paths = flavorOf(options.platform ?? process.platform)
  const { modelRoot } = resolveLayout(config, options)
  return ASSETS.map((asset) => ({
    key: asset.key,
    url: applySource(HUB_BASE_URL + asset.key, source),
    path: paths.join(modelRoot, asset.key),
    bytes: asset.bytes,
  }))
}

/**
 * The environment Voz's worker child needs.
 *
 * DAL_CACHE_ROOT is the meaningful one: platform-node.js reads it to decide where
 * the bundle lives, so pointing it at the root preparation used is what makes the
 * child adopt the downloaded files instead of fetching them again.
 *
 * @param config - resolved provider config; `modelRoot` is the override.
 * @param options - injectable environment, platform and home directory.
 * @returns environment entries to merge over the host's own.
 */
export function workerEnv(config = {}, options = {}) {
  const { cacheRoot, modelRoot } = resolveLayout(config, options)
  return { DAL_CACHE_ROOT: cacheRoot, DSH_STT_VOZ_MODEL_ROOT: modelRoot }
}

/**
 * Provider facts for one configuration.
 * @param config - resolved provider config; `id`/`providerId` and `name` may be overridden.
 * @returns the seam's SpeechProviderInfo.
 */
function infoFor(config) {
  return {
    id: config.providerId ?? config.id ?? DEFAULT_ID,
    name: config.name ?? DEFAULT_NAME,
    location: 'host-local',
    languages: LANGUAGES,
    // 384,832,967 B of bundle plus headroom; ~674 MB resident after load and
    // ~1000 MB after a transcription, so 1.4 GB is the honest expectation.
    setupEstimate: {
      recommendedDiskBytes: 500000000,
      expectedMemoryBytes: 1400000000,
      minimumMinutes: 2,
      // A cold download measured ~15 minutes on this link.
      maximumMinutes: 30,
    },
    downloadSources: ['https://huggingface.co', 'https://hf-mirror.com'],
  }
}

/**
 * Overlay a call-time config on the config the spec was built with.
 * @param base - config captured by createSpec.
 * @param override - config passed to one spec method, if any.
 * @returns the merged config, with absent override fields left alone.
 */
function withConfig(base, override) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value !== undefined && value !== null) merged[key] = value
  }
  return merged
}

/**
 * Build the Voz spec for one configuration.
 *
 * The config is accepted here and per call: a registry that builds one spec per
 * provider can pass it once, and a registry that hands the config to each method
 * works the same way - which matters, because `modelRoot` must reach `assets`
 * and `workerEnv` alike or the download and the worker would disagree about
 * where the bundle lives.
 *
 * @param config - resolved provider config, or nothing for the platform defaults.
 * @returns the spec createWorkerProvider consumes, plus its two timeouts.
 */
export function createSpec(config = {}) {
  const base = config ?? {}
  const settings = (override) => withConfig(base, override)
  return {
    name: 'Voz',
    workerEntry: WORKER_ENTRY,
    timeoutMs: TIMEOUT_MS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    info: (override) => infoFor(settings(override)),
    assets: (source, override) => assets(source, settings(override)),
    workerEnv: (override) => workerEnv(settings(override)),
  }
}

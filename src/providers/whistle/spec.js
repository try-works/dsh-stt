/**
 * Whistle (Cactus Compute) as a one-shot command provider.
 *
 * The engine binary loads a 16.9 MB speech model in roughly 30 ms, so there is no
 * load cost worth amortising: one process per recording buys crash isolation and
 * hands every byte of model memory back when it exits. Nothing here keeps state
 * between requests, so the spec stays a pure description of files, argv and output.
 *
 * Only the engine binary is platform-specific. whistle.cact is a portable model file
 * and is downloaded from its own repository.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applySource } from '../../provider-kit/http.js'
import { canonicalWav, parseWav, segment } from '../../provider-kit/audio.js'

/** Language hints the engine accepts, plus 'auto' for its own detection. */
export const LANGUAGES = Object.freeze(['auto', 'en', 'de', 'fr', 'es', 'it', 'nl', 'pl'])

/** Display name used in the picker and in error messages. */
export const DEFAULT_NAME = 'Whistle (Cactus Compute)'

/** Local file name of the engine binary inside the model root. */
export const ENGINE_FILE = 'needle.exe'

/** Local file name of the speech model inside the model root. */
export const MODEL_FILE = 'whistle.cact'

/** Measured size of the engine binary, as published. */
export const ENGINE_BYTES = 1563136

/** Measured size of the speech model, as published. */
export const MODEL_BYTES = 16919407

/** Per-recording deadline: the engine answers a five second clip in about half a second. */
export const TIMEOUT_MS = 120000

/**
 * Longest audio the engine accepts in one invocation.
 *
 * The model is trained on 30 s and the binary refuses more with `audio limit is
 * 30 s`. There is no flag to raise it - it is a property of the model, not a default
 * - and the engine's own `--audio-stream` mode is not a substitute: it re-decodes a
 * growing buffer, and its per-pass time was measured climbing from 0.4 s to 3.5 s
 * over eleven seconds of audio.
 */
export const MAX_AUDIO_SECONDS = 29.5

/** Repository that publishes the platform-specific engine binaries. */
const ENGINE_REPOSITORY = 'https://huggingface.co/Cactus-Compute/needle3/resolve/main'

/** The speech model itself, portable across platforms. */
const MODEL_URL = 'https://huggingface.co/Cactus-Compute/whistle/resolve/main/' + MODEL_FILE

/** Every platform the upstream repository publishes an engine binary for. */
export const PLATFORM_DIRECTORIES = Object.freeze({
  'win32-x64': 'windows-x86_64',
  'win32-arm64': 'windows-arm64',
  'darwin-arm64': 'macos-arm64',
  'linux-x64': 'linux-x86_64',
  'linux-arm64': 'linux-arm64',
})

/**
 * Directory inside the needle3 repository that holds one platform's engine binary.
 *
 * Resolution is deliberately strict: an unknown pair throws instead of falling back
 * to a plausible-looking directory, because downloading the wrong executable would
 * only surface as an unexplained spawn failure later.
 *
 * @param platform - a Node process.platform value; defaults to the host.
 * @param arch - a Node process.arch value; defaults to the host.
 * @returns the repository subdirectory holding the engine binary.
 * @throws when no prebuilt engine exists for the pair.
 */
export function platformDirectory(platform = process.platform, arch = process.arch) {
  const key = platform + '-' + arch
  const directory = PLATFORM_DIRECTORIES[key]
  if (directory === undefined) {
    throw new Error(
      'Whistle publishes no engine binary for ' + key +
      '; supported platforms are ' + Object.keys(PLATFORM_DIRECTORIES).join(', '),
    )
  }
  return directory
}

/**
 * Download URL of the engine binary for one platform.
 * @param platform - a Node process.platform value; defaults to the host.
 * @param arch - a Node process.arch value; defaults to the host.
 * @returns the absolute URL of the engine binary.
 * @throws when no prebuilt engine exists for the pair.
 */
export function engineUrl(platform = process.platform, arch = process.arch) {
  return ENGINE_REPOSITORY + '/' + platformDirectory(platform, arch) + '/' + ENGINE_FILE
}

/**
 * Duration of a canonical 16 kHz mono PCM16 WAV.
 *
 * The engine reports no duration of its own, and every recording reaching a provider
 * is already the canonical 16 kHz mono PCM16 form the seam records.
 *
 * @param bytes - whole-file length in bytes, header included.
 * @returns the audio duration in seconds, or undefined when the file cannot hold a sample.
 */
export function audioSecondsFromWavBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 44) return undefined
  return (bytes - 44) / 32000
}

/**
 * Parse the last JSON object printed on stdout.
 *
 * Scanning backwards tolerates a diagnostic line printed before the result, and the
 * engine's own failures are non-zero exits reported on stderr, which never reach here.
 *
 * @param stdout - the engine's complete standard output.
 * @returns the parsed object, or null when no line held one.
 */
function lastJsonLine(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object') return value
    } catch {
      // Not a result line; keep looking backwards.
    }
  }
  return null
}

/**
 * Read an audio duration out of the engine's JSON, when it reports one.
 * @param report - the parsed result object.
 * @returns the duration in seconds, or undefined.
 */
function reportedDuration(report) {
  const candidates = [report.audio_seconds, report.audioSeconds, report.duration, report.audio_duration]
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/**
 * Turn one stdout line into a transcript.
 *
 * @param stdout - the engine's complete standard output, one JSON line.
 * @param wavBytes - optional length of the recording, used when the JSON carries no duration.
 * @returns the recognized text and the audio duration when one can be established.
 * @throws when no JSON result line was printed.
 */
export function parse(stdout, wavBytes) {
  const report = lastJsonLine(stdout)
  if (report === null) {
    const excerpt = String(stdout ?? '').trim().slice(0, 200)
    throw new Error('Whistle printed no JSON result' + (excerpt === '' ? '' : ': ' + excerpt))
  }
  return {
    text: typeof report.text === 'string' ? report.text.trim() : '',
    audioSeconds: reportedDuration(report) ?? audioSecondsFromWavBytes(wavBytes),
  }
}

/**
 * Translate a language hint into the engine's --audio-language value.
 *
 * 'auto' is not a value the engine accepts, and anything outside its seven languages
 * is rejected outright, so both mean "let the model detect it" and omit the flag.
 *
 * @param language - the caller's language hint.
 * @returns the flag value, or undefined to leave language detection to the model.
 */
function languageCode(language) {
  if (typeof language !== 'string') return undefined
  const code = language.trim().toLowerCase()
  if (code === '' || code === 'auto') return undefined
  return LANGUAGES.includes(code) ? code : undefined
}

/**
 * Build the Whistle provider spec.
 *
 * The kit calls info(config) before it ever calls assets(), so the model root carried
 * by that config is adopted here; this is what lets createSpec() be constructed before
 * the resolved config is known, while assets() still returns absolute paths.
 *
 * @param config - optional resolved provider config, chiefly its modelRoot.
 * @returns the speech provider spec consumed by the one-shot kit.
 */
/**
 * Build the engine's argv for one audio file.
 * @param base - the model root holding the engine and the model.
 * @param audioPath - the WAV to transcribe.
 * @param language - the requested language hint, possibly 'auto'.
 * @returns the arguments, with the language flag only when the engine accepts the code.
 */
function engineArgs(base, audioPath, language) {
  const args = ['--model', join(base, MODEL_FILE), '--audio', audioPath]
  const code = languageCode(language)
  if (code !== undefined) args.push('--audio-language', code)
  return args
}

export function createSpec(config = {}) {
  let modelRoot = config.modelRoot === undefined ? undefined : String(config.modelRoot)

  /** Adopt a model root from a config the kit resolved later. */
  const adopt = (candidate) => {
    if (modelRoot === undefined && candidate?.modelRoot !== undefined) modelRoot = String(candidate.modelRoot)
  }

  /** The model root every path is built from. @returns the absolute model root. */
  const requireModelRoot = () => {
    if (modelRoot === undefined || modelRoot === '') {
      throw new Error('Whistle needs config.modelRoot to locate its engine and model')
    }
    return modelRoot
  }

  return {
    name: DEFAULT_NAME,

    /**
     * Public provider facts; no paths or credentials leave this call.
     * @param callConfig - the resolved config, which may supply the id and display name.
     * @returns the SpeechProviderInfo the picker renders.
     * @throws when this platform has no engine binary to offer.
     */
    info(callConfig = config) {
      adopt(callConfig)
      platformDirectory()
      return {
        id: callConfig?.id ?? 'whistle',
        name: callConfig?.name ?? DEFAULT_NAME,
        location: 'host-local',
        languages: LANGUAGES,
        setupEstimate: {
          recommendedDiskBytes: 25 * 1024 * 1024,
          expectedMemoryBytes: 250 * 1024 * 1024,
          minimumMinutes: 0,
          maximumMinutes: 2,
        },
        downloadSources: ['https://huggingface.co', 'https://hf-mirror.com'],
      }
    },

    /**
     * The two files this provider needs on disk.
     *
     * The engine is listed first so the small binary lands before the model and the
     * progress bar moves early. URLs are already rewritten onto the chosen origin;
     * the preparation kit rewrites again, which is idempotent.
     *
     * @param source - a chosen download origin, or undefined to keep the canonical one.
     * @param platform - a Node process.platform value; defaults to the host.
     * @param arch - a Node process.arch value; defaults to the host.
     * @returns the asset records the preparation controller downloads.
     * @throws when this platform has no engine binary or the model root is unknown.
     */
    assets(source, platform = process.platform, arch = process.arch) {
      const root = requireModelRoot()
      return [
        {
          key: 'engine',
          url: applySource(engineUrl(platform, arch), source),
          path: join(root, ENGINE_FILE),
          bytes: ENGINE_BYTES,
        },
        {
          key: 'model',
          url: applySource(MODEL_URL, source),
          path: join(root, MODEL_FILE),
          bytes: MODEL_BYTES,
        },
      ]
    },

    /**
     * Build the argv for one recording.
     *
     * Word timestamps are not requested: neither the transcript nor the provider
     * interface has anywhere to carry them. The engine also offers --audio-keywords,
     * left unused because a keyword file would outlive the invocation that wrote it.
     *
     * @param options - the staged WAV, the model root and the language hint.
     * @returns the executable, its arguments and no working-directory requirement.
     */
    command({ modelRoot: root, wavPath, language }) {
      const base = root === undefined || root === null || root === '' ? requireModelRoot() : String(root)
      return { file: join(base, ENGINE_FILE), args: engineArgs(base, String(wavPath), language) }
    },

    /**
     * Plan one invocation per segment the engine will accept.
     *
     * The engine refuses more than 30 s in a single call, so a longer recording is cut
     * at the quietest frame near each boundary and handed over one process per segment,
     * which the kit then joins in order. The seam admits at most 120 s, so at most five
     * invocations are ever planned; a recording inside the cap stays a single pass.
     *
     * @param options - the staged WAV, its directory, the model root and the raw audio.
     * @returns one invocation per segment, in order.
     */
    plan({ modelRoot: root, wavPath, directory, audio, language }) {
      const base = root === undefined || root === null || root === '' ? requireModelRoot() : String(root)
      const engine = join(base, ENGINE_FILE)
      const wav = parseWav(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength))
      const spans = segment(wav.data, MAX_AUDIO_SECONDS)
      if (spans.length === 1) return [{ file: engine, args: engineArgs(base, String(wavPath), language) }]
      return spans.map(([from, to], index) => {
        const part = join(directory, 'segment-' + index + '.wav')
        writeFileSync(part, canonicalWav(wav.data.subarray(from, to)))
        return { file: engine, args: engineArgs(base, part, language) }
      })
    },

    parse,
  }
}

export default createSpec

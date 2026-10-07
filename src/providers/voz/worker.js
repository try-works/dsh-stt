/**
 * The Voz recognition child: one long-lived Node process holding the loaded model
 * between recordings.
 *
 * A child rather than the host process because Voz costs 6.2 s and ~1 GB resident
 * to load (measured), and because the bundle wires WASI's proc_exit straight to
 * process.exit - a core abort would otherwise take the DSH host with it. The kit
 * spawns this file, keeps it until the idle deadline, and kills it after.
 *
 * Protocol, JSON lines on stdio (see provider-kit/worker.js):
 *
 *     -> {"event":"started"}                                  once, before any load
 *     <- {"id":1,"op":"load"}                                 load only, no audio
 *     <- {"id":1,"op":"transcribe","wavPath":"C:\\...\\input.wav","language":"en"}
 *     -> {"id":1,"ok":true,"text":"...","audioSeconds":7.62}
 *     -> {"id":1,"ok":false,"error":"..."}
 *
 * The model is loaded inside the first transcribe and kept afterwards, so only the
 * first recording pays the load.
 */
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { ASSETS, resolveLayout } from './spec.js'

/** The loaded recognizer, reused by every later request. */
let engine = null

/** The in-flight load, so a retry after a failure starts a fresh one. */
let loading = null

/**
 * Write one reply line.
 * @param message - the object to serialize onto its own stdout line.
 * @returns nothing.
 */
function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

/**
 * The directory the bundle is expected in.
 * @returns the absolute model directory, from the environment the kit passed.
 */
function bundleDirectory() {
  return process.env.DSH_STT_VOZ_MODEL_ROOT ?? resolveLayout().modelRoot
}

/**
 * Refuse to load when the bundle is not already on disk.
 *
 * Voz.load() would otherwise fetch it with one un-retried, un-resumable request
 * per file - measured to fail at 37.5% of the 349 MB encoder data file - and stay
 * silent for minutes while it does. Preparation owns downloading; this reports
 * what is missing instead, and never starts a download of its own.
 *
 * @returns the directory the bundle was verified in.
 */
function assertBundlePresent() {
  const directory = bundleDirectory()
  const missing = ASSETS.filter((asset) => {
    try {
      return statSync(join(directory, asset.key)).size !== asset.bytes
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    throw new Error(
      `Voz's model files are missing or incomplete in ${directory}: `
        + `${missing.map((asset) => asset.key).join(', ')}. `
        + 'Prepare the model in the speech settings before transcribing.',
    )
  }
  return directory
}

/**
 * Import a package, optionally resolved from an explicit node_modules root.
 *
 * The override exists for a checkout whose dependencies are not installed under
 * the worker's own path; a real deployment imports both packages by name.
 *
 * @param specifier - the bare package name.
 * @param root - a node_modules root, or undefined to resolve from this file.
 * @returns the imported module namespace.
 */
async function importPackage(specifier, root) {
  if (root === undefined || root === '') return await import(specifier)
  const require = createRequire(join(root, 'noop.js'))
  return await import(pathToFileURL(require.resolve(specifier)).href)
}

/**
 * Load onnxruntime-node and Voz, then compile the bundle from the prepared cache.
 * @returns the loaded recognizer.
 */
async function load() {
  const directory = assertBundlePresent()
  const root = process.env.DSH_STT_VOZ_MODULE_ROOT
  const [ort, voz] = await Promise.all([
    importPackage('onnxruntime-node', root),
    importPackage('@desert-ant-labs/voz', root),
  ])
  // cache: true is what makes preparation count: the library tests each file with
  // fs.existsSync and adopts it, so a prepared bundle costs no network at all.
  const loaded = await voz.Voz.load({ ort, cache: true })
  process.stderr.write(`voz: model loaded from ${directory}\n`)
  return loaded
}

/**
 * The warm recognizer, loading it on first use.
 * @returns the loaded Voz instance.
 */
async function recognize() {
  if (engine !== null) return engine
  if (loading === null) {
    loading = load().then(
      (loaded) => {
        engine = loaded
        return loaded
      },
      (error) => {
        loading = null
        throw error
      },
    )
  }
  return await loading
}

/**
 * Answer one protocol line.
 * @param line - one JSON line from the parent.
 * @returns after the reply, if any, is written.
 */
async function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write('voz: ignored a non-JSON line\n')
    return
  }
  if (message === null || typeof message !== 'object' || (message.op !== 'transcribe' && message.op !== 'load')) {
    reply({ id: message?.id, ok: false, error: `unsupported op ${String(message?.op)}` })
    return
  }
  try {
    const voz = await recognize()
    // 'load' pays the model cost with no audio, so a caller can start it while the
    // user is still speaking and the wait never lands after the recording.
    if (message.op === 'load') {
      reply({ id: message.id, ok: true })
      return
    }
    // 'language' is deliberately unused: Voz's transcribe() takes no language,
    // because the bundle is multilingual and picks one itself. The picker's list
    // of 25 codes is where the hint is enforced, and there is no 'auto' there.
    const result = await voz.transcribe(String(message.wavPath))
    reply({
      id: message.id,
      ok: true,
      text: typeof result.text === 'string' ? result.text : '',
      audioSeconds: result.duration,
    })
  } catch (error) {
    reply({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Ready for work - and deliberately not one byte of the model loaded yet. */
process.stdout.write(JSON.stringify({ event: 'started' }) + '\n')

const lines = createInterface({ input: process.stdin })
let queue = Promise.resolve()
// One at a time: the model holds process-global ONNX sessions and the kit
// serializes its own requests, so ordering here only has to preserve that.
lines.on('line', (line) => {
  queue = queue.then(() => handle(line)).catch((error) => {
    // handle() answers everything it can; this only keeps one bad line from
    // wedging the queue, which would look like a hang to the parent.
    process.stderr.write(`voz: ${error instanceof Error ? error.message : String(error)}\n`)
  })
})
// The parent closing stdin means it is going away; nothing here outlives it.
lines.on('close', () => {
  process.exit(0)
})

/** Provider factory for engines that run as a one-shot command per recording. */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Write one recording to a private scratch directory.
 * @param audio - canonical 16 kHz mono PCM16 WAV bytes.
 * @returns the directory and the WAV path inside it.
 */
export async function stageRecording(audio) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stt-'))
  const path = join(directory, 'input.wav')
  await writeFile(path, audio)
  return { directory, path }
}

/**
 * Run one command to completion, capturing its output.
 * @param options - executable, arguments, deadline and cancellation.
 * @returns stdout, stderr and the exit code.
 */
export function runCommand({ file, args, cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const kill = () => {
      try {
        child.kill()
      } catch {
        // The process already exited; nothing to release.
      }
    }
    const onAbort = () => {
      kill()
      finish(reject, new Error('cancelled'))
    }
    const timer = setTimeout(() => {
      kill()
      finish(reject, new Error('inference exceeded ' + timeoutMs + ' ms'))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { finish(reject, error) })
    child.on('close', (code) => { finish(resolve, { stdout, stderr, code: code ?? -1 }) })
  })
}

/**
 * Build a provider whose engine runs as one or more command invocations.
 *
 * One-shot execution satisfies the engine's one-model-per-process rule for free,
 * reclaims all memory when the process exits, and turns a crash into a failed
 * request rather than a failed DSH host.
 *
 * A spec may supply `plan` instead of `command` when the engine caps how much audio
 * one invocation accepts. The kit runs every invocation in order and joins the
 * transcripts, so a long recording is transcribed by the same engine that refuses
 * it outright in a single pass.
 *
 * @param options - the model spec, resolved config, and logging.
 * @returns a SpeechProvider.
 */
export function createOneShotProvider({ spec, config, preparation, logger, timeoutMs }) {
  const { modelRoot } = config
  return {
    info: spec.info(config),
    preparation,
    async transcribe(input, signal) {
      signal.throwIfAborted()
      const staged = await stageRecording(input.audio)
      const started = Date.now()
      try {
        const shared = { modelRoot, wavPath: staged.path, directory: staged.directory, audio: input.audio, language: input.language, config }
        const invocations = typeof spec.plan === 'function' ? spec.plan(shared) : [spec.command(shared)]
        const parts = []
        for (const invocation of invocations) {
          const result = await runCommand({ ...invocation, timeoutMs, signal })
          if (result.code !== 0) {
            const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')
            throw new Error(spec.name + ' exited with code ' + result.code + (detail === '' ? '' : ': ' + detail))
          }
          const parsed = spec.parse(result.stdout)
          if (typeof parsed.text === 'string' && parsed.text !== '') parts.push(parsed.text)
        }
        return {
          text: parts.join(' '),
          // Duration is the whole recording, not the last segment.
          audioSeconds: (input.audio.length - 44) / 32000,
          inferenceSeconds: (Date.now() - started) / 1000,
        }
      } finally {
        await rm(staged.directory, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}

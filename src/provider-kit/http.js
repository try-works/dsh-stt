/** Resumable HTTP asset download with byte progress, shared by every provider's preparation step. */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Size of a file, or 0 when it does not exist.
 * @param path - absolute file path.
 * @returns the byte length, or 0.
 */
export async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * True when a file exists with exactly the expected length.
 * @param path - absolute file path.
 * @param bytes - expected byte length.
 * @returns whether the file is present and complete.
 */
export async function isComplete(path, bytes) {
  return await sizeOf(path) === bytes
}

/** @param ms - milliseconds. @param signal - optional cancellation. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Download one asset, resuming a partial transfer with HTTP Range.
 *
 * The upstream Voz package downloads with a single fetch and no retry, so a
 * transient TLS drop loses the whole transfer - measured on this machine as a
 * failure at 37.5% of a 349 MB file, and three more drops on a resumable retry.
 * Every provider therefore fetches through this function instead.
 *
 * @param options - url, destination, expected size, cancellation and progress.
 * @returns the completed byte length and whether it was already present.
 */
export async function downloadAsset({ url, destination, expectedBytes, signal, onProgress, maxAttempts = 6 }) {
  if (expectedBytes !== undefined && await isComplete(destination, expectedBytes)) {
    onProgress?.(expectedBytes, expectedBytes)
    return { bytes: expectedBytes, skipped: true, attempts: 0 }
  }
  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.partial`
  let lastError = new Error(`${url} was not attempted`)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error('cancelled')
    const start = await sizeOf(partial)
    let written = start
    try {
      const response = await fetch(url, {
        headers: start > 0 ? { Range: `bytes=${start}-` } : {},
        signal,
        redirect: 'follow',
      })
      if (start > 0 && response.status === 200) written = 0
      else if (start > 0 && response.status === 416) {
        // The partial file already covers the whole resource.
        if (expectedBytes !== undefined && start >= expectedBytes) {
          await rm(destination, { force: true })
          await rename(partial, destination)
          return { bytes: start, skipped: false, attempts: attempt }
        }
        throw new Error('HTTP 416: the server holds ' + start + ' bytes but ' + expectedBytes + ' were expected')
      } else if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const resumed = start > 0 && written === start
      if (response.body === null) throw new Error('the response carried no body')
      const length = Number(response.headers.get('content-length') ?? 0)
      const total = expectedBytes ?? (length > 0 ? written + length : undefined)
      onProgress?.(written, total)
      const body = Readable.fromWeb(response.body)
      body.on('data', (chunk) => {
        written += chunk.length
        onProgress?.(written, total)
      })
      await pipeline(body, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }))
      if (expectedBytes !== undefined && written !== expectedBytes) {
        throw new Error(`expected ${expectedBytes} bytes but received ${written}`)
      }
      await rm(destination, { force: true })
      await rename(partial, destination)
      return { bytes: written, skipped: false, attempts: attempt }
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw new Error('cancelled')
      // A definitive size mismatch is terminal: the published bytes no longer match
      // what we expect, and resuming at the received offset would surface a
      // misleading 416 instead of the real integrity failure.
      if (error instanceof Error && /expected \d+ bytes but received \d+/.test(error.message)) throw error
      if (attempt === maxAttempts) break
      await sleep(Math.min(1000 * attempt, 5000), signal)
    }
  }
  throw lastError
}

/**
 * Rewrite an asset URL onto a chosen origin.
 * @param url - the asset's canonical URL.
 * @param origin - an advertised download origin, or undefined to keep the original.
 * @returns the URL to fetch.
 */
export function applySource(url, origin) {
  if (origin === undefined || origin === '') return url
  const parsed = new URL(url)
  const chosen = new URL(origin)
  parsed.protocol = chosen.protocol
  parsed.host = chosen.host
  return parsed.toString()
}

/**
 * The shared provider kit: the resumable HTTP downloader and the preparation
 * controller every provider is assembled from.
 *
 * The downloader is tested against a loopback HTTP server this file starts itself,
 * so range resumption, progress reporting and cancellation are observed for real
 * instead of being mocked. Nothing here leaves the machine.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { applySource, downloadAsset, isComplete, sizeOf } from '../src/provider-kit/http.js'
import { createPreparation } from '../src/provider-kit/preparation.js'

/** Scratch root holding every temp directory this suite creates; removed on exit. */
let scratch = null

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-stt-kit-'))
})

after(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/**
 * A private temp directory for one test.
 * @param name - a prefix naming the test that owns it.
 * @returns the absolute directory path.
 */
async function scratchDir(name) {
  return await mkdtemp(join(scratch, name + '-'))
}

/**
 * Body bytes whose position is visible, so a wrong offset or a truncated
 * transfer cannot pass by comparing lengths alone.
 * @param bytes - the body length.
 * @returns the payload buffer.
 */
function payload(bytes) {
  const body = Buffer.alloc(bytes)
  for (let index = 0; index < bytes; index += 1) body[index] = (index * 7) % 251
  return body
}

/**
 * Start a loopback HTTP server for one test.
 * @param handler - called with each request, its response and the log entry to fill in.
 * @returns the origin to fetch, the request log, and a close() that cannot hang.
 */
async function startServer(handler) {
  const requests = []
  const server = createServer((request, response) => {
    // A cancelled download destroys its socket mid-write; without these listeners
    // the failure would surface as an unhandled 'error' event.
    request.on('error', () => {})
    response.on('error', () => {})
    const entry = { url: request.url, range: request.headers.range ?? null, status: 0 }
    requests.push(entry)
    handler(request, response, entry)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    requests,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Answer one request with a byte range of a body, the way a file server does.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param entry - the request log entry receiving the status.
 * @param body - the complete resource.
 */
function serveRange(request, response, entry, body) {
  const match = /^bytes=(\d+)-$/.exec(String(request.headers.range ?? ''))
  const start = match === null ? 0 : Number(match[1])
  if (start >= body.length) {
    entry.status = 416
    response.writeHead(416, { 'content-range': 'bytes */' + body.length })
    response.end()
    return
  }
  const slice = body.subarray(start)
  entry.status = match === null ? 200 : 206
  response.writeHead(entry.status, {
    'accept-ranges': 'bytes',
    'content-length': String(slice.length),
    ...(match === null ? {} : { 'content-range': 'bytes ' + start + '-' + (body.length - 1) + '/' + body.length }),
  })
  response.end(slice)
}

/**
 * Poll a preparation controller until it publishes one phase.
 * @param preparation - the controller under test.
 * @param phase - the phase to wait for.
 * @param timeoutMs - how long to keep polling.
 * @returns the phase observed last, whether or not it is the wanted one.
 */
async function waitForPhase(preparation, phase, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let observed = preparation.snapshot().phase
  while (observed !== phase && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    observed = preparation.snapshot().phase
  }
  return observed
}

/**
 * Write a real file and describe it as a preparation asset.
 * @param directory - where the file lives.
 * @param key - the asset's identifier.
 * @param bytes - the exact file length.
 * @param url - where the asset would be fetched from; never fetched by inspect().
 * @returns the kit's asset record.
 */
async function assetFile(directory, key, bytes, url) {
  const file = join(directory, key)
  await writeFile(file, payload(bytes))
  return { key, url, path: file, bytes }
}

test('sizeOf reports 0 for a missing file and the real length for an existing one', async () => {
  const directory = await scratchDir('size')
  const file = join(directory, 'asset.bin')
  assert.equal(await sizeOf(file), 0)
  await writeFile(file, payload(1234))
  assert.equal(await sizeOf(file), 1234)
})

test('isComplete is exact', async () => {
  const directory = await scratchDir('complete')
  const file = join(directory, 'asset.bin')
  assert.equal(await isComplete(file, 5), false, 'a missing file is not complete')
  await writeFile(file, payload(5))
  assert.equal(await isComplete(file, 5), true)
  await truncate(file, 4)
  assert.equal(await isComplete(file, 5), false, 'one byte short is not complete')
  await truncate(file, 6)
  assert.equal(await isComplete(file, 5), false, 'one byte long is not complete either')
})

test('applySource rewrites the origin and keeps the path', () => {
  const canonical = 'https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact'
  assert.equal(
    applySource(canonical, 'https://hf-mirror.com'),
    'https://hf-mirror.com/Cactus-Compute/whistle/resolve/main/whistle.cact',
  )
  assert.equal(
    applySource(canonical, 'http://mirror.internal:8080'),
    'http://mirror.internal:8080/Cactus-Compute/whistle/resolve/main/whistle.cact',
    'protocol and port come from the chosen origin too',
  )
  assert.equal(
    applySource('https://huggingface.co/a/b?download=true', 'https://hf-mirror.com'),
    'https://hf-mirror.com/a/b?download=true',
    'the query travels with the path',
  )
  assert.equal(applySource(canonical, undefined), canonical, 'no choice keeps the canonical URL')
  assert.equal(applySource(canonical, ''), canonical, 'an empty origin keeps the canonical URL')
})

test('downloadAsset fetches a fresh file, reports progress and lands the exact bytes', async (t) => {
  const body = payload(200 * 1024)
  const server = await startServer((request, response, entry) => {
    serveRange(request, response, entry, body)
  })
  t.after(() => server.close())

  const directory = await scratchDir('fresh')
  const destination = join(directory, 'nested', 'asset.bin')
  const progress = []
  const result = await downloadAsset({
    url: server.origin + '/asset',
    destination,
    expectedBytes: body.length,
    onProgress: (done, total) => progress.push([done, total]),
  })

  assert.deepEqual(result, { bytes: body.length, skipped: false, attempts: 1 })
  assert.deepEqual(await readFile(destination), body)
  assert.equal(existsSync(destination + '.partial'), false, 'the partial is renamed away')
  assert.equal(server.requests.length, 1)
  assert.equal(server.requests[0].range, null, 'a fresh download asks for the whole resource')
  assert.equal(server.requests[0].status, 200)

  const done = progress.map(([received]) => received)
  assert.ok(progress.length >= 2, 'progress was reported at least twice')
  assert.deepEqual(progress[0], [0, body.length], 'progress opens at zero of the expected size')
  assert.deepEqual(progress.at(-1), [body.length, body.length], 'progress closes on the last byte')
  assert.deepEqual(done, [...done].sort((left, right) => left - right), 'progress never goes backwards')
})

test('a second download of a complete file is a no-op with skipped: true', async (t) => {
  const body = payload(64 * 1024)
  const server = await startServer((request, response, entry) => {
    serveRange(request, response, entry, body)
  })
  t.after(() => server.close())

  const directory = await scratchDir('skip')
  const destination = join(directory, 'asset.bin')
  const url = server.origin + '/asset'
  await downloadAsset({ url, destination, expectedBytes: body.length })

  const progress = []
  const second = await downloadAsset({
    url,
    destination,
    expectedBytes: body.length,
    onProgress: (received, total) => progress.push([received, total]),
  })

  assert.deepEqual(second, { bytes: body.length, skipped: true, attempts: 0 })
  assert.deepEqual(progress, [[body.length, body.length]], 'the skip is reported as already complete')
  assert.equal(server.requests.length, 1, 'nothing was fetched a second time')
})

test('a pre-existing .partial is resumed with a Range request', async (t) => {
  const body = payload(200 * 1024)
  const server = await startServer((request, response, entry) => {
    serveRange(request, response, entry, body)
  })
  t.after(() => server.close())

  const directory = await scratchDir('resume')
  const destination = join(directory, 'asset.bin')
  const partial = destination + '.partial'
  const already = 50 * 1024
  await writeFile(partial, body.subarray(0, already))

  const progress = []
  const result = await downloadAsset({
    url: server.origin + '/asset',
    destination,
    expectedBytes: body.length,
    onProgress: (received) => progress.push(received),
  })

  assert.deepEqual(result, { bytes: body.length, skipped: false, attempts: 1 })
  assert.equal(server.requests.length, 1)
  assert.equal(server.requests[0].range, 'bytes=' + already + '-', 'the server was asked for the remainder')
  assert.equal(server.requests[0].status, 206)
  assert.deepEqual(await readFile(destination), body, 'the resumed transfer assembles the whole file')
  assert.equal(existsSync(partial), false)
  assert.equal(progress[0], already, 'progress starts from the bytes already on disk')
  assert.equal(progress.at(-1), body.length)
})

test('a .partial that already covers the resource is promoted instead of downloaded again', async (t) => {
  const body = payload(64 * 1024)
  const server = await startServer((request, response, entry) => {
    serveRange(request, response, entry, body)
  })
  t.after(() => server.close())

  const directory = await scratchDir('promote')
  const destination = join(directory, 'asset.bin')
  const partial = destination + '.partial'
  await writeFile(partial, body)

  const result = await downloadAsset({ url: server.origin + '/asset', destination, expectedBytes: body.length })

  assert.deepEqual(result, { bytes: body.length, skipped: false, attempts: 1 })
  assert.equal(server.requests[0].range, 'bytes=' + body.length + '-')
  assert.equal(server.requests[0].status, 416, 'the server has nothing left to send')
  assert.deepEqual(await readFile(destination), body)
  assert.equal(existsSync(partial), false)
})

test('an unexpected byte count throws instead of landing a wrong file', async (t) => {
  const body = payload(64 * 1024)
  const server = await startServer((request, response, entry) => {
    serveRange(request, response, entry, body)
  })
  t.after(() => server.close())

  const directory = await scratchDir('integrity')
  const destination = join(directory, 'asset.bin')
  const expected = body.length + 5
  // One attempt, so the integrity check itself is observed instead of six backoffs.
  const download = downloadAsset({
    url: server.origin + '/asset',
    destination,
    expectedBytes: expected,
    maxAttempts: 1,
  })

  await assert.rejects(download, (error) => {
    assert.equal(error.message, 'expected ' + expected + ' bytes but received ' + body.length)
    return true
  })
  assert.equal(existsSync(destination), false, 'a short transfer is never promoted')
  assert.equal(await sizeOf(destination + '.partial'), body.length, 'the received bytes stay for the next attempt')
})

test('an aborted download rejects as cancelled and leaves the partial behind', async (t) => {
  const body = payload(1024 * 1024)
  const server = await startServer((request, response, entry) => {
    entry.status = 200
    response.writeHead(200, { 'content-length': String(body.length) })
    let sent = 0
    const timer = setInterval(() => {
      if (sent >= body.length) {
        clearInterval(timer)
        response.end()
        return
      }
      const chunk = body.subarray(sent, sent + 32 * 1024)
      sent += chunk.length
      response.write(chunk)
    }, 20)
    request.on('close', () => clearInterval(timer))
  })
  t.after(() => server.close())

  const directory = await scratchDir('abort')
  const destination = join(directory, 'asset.bin')
  const partial = destination + '.partial'
  const controller = new AbortController()
  const progress = []
  const download = downloadAsset({
    url: server.origin + '/slow',
    destination,
    expectedBytes: body.length,
    signal: controller.signal,
    onProgress: (received) => {
      progress.push(received)
      if (received >= 128 * 1024) controller.abort()
    },
  })

  await assert.rejects(download, (error) => {
    assert.equal(error.message, 'cancelled')
    return true
  })
  assert.equal(existsSync(destination), false)
  assert.ok(existsSync(partial), 'the bytes already received are kept for a resume')
  const kept = await sizeOf(partial)
  assert.ok(kept > 0, 'a partial transfer holds data')
  assert.ok(progress.at(-1) >= 128 * 1024, 'the abort landed after real progress')
  assert.deepEqual(await readFile(partial), body.subarray(0, kept), 'the partial is a clean prefix of the resource')
})

test('a provider is unprepared before inspect() and standby after it when every asset is complete', async () => {
  const directory = await scratchDir('inspect-ok')
  const assets = [
    await assetFile(directory, 'engine', 4096, 'http://127.0.0.1:9/engine'),
    await assetFile(directory, 'model', 8192, 'http://127.0.0.1:9/model'),
  ]
  const preparation = createPreparation({ assets: () => assets })

  assert.deepEqual(preparation.snapshot(), { phase: 'unprepared' })
  let notifications = 0
  preparation.subscribe(() => { notifications += 1 })

  await preparation.inspect()

  assert.equal(preparation.snapshot().phase, 'standby')
  assert.equal(notifications, 1, 'the inspection publishes once')
})

test('inspect() reports unprepared for a missing asset and for a short one', async () => {
  const directory = await scratchDir('inspect-bad')
  const complete = await assetFile(directory, 'engine', 4096, 'http://127.0.0.1:9/engine')
  const short = {
    key: 'model',
    url: 'http://127.0.0.1:9/model',
    path: join(directory, 'model'),
    bytes: 8192,
  }
  await writeFile(short.path, payload(8191))

  const shortPreparation = createPreparation({ assets: () => [complete, short] })
  await shortPreparation.inspect()
  assert.equal(shortPreparation.snapshot().phase, 'unprepared', 'a short file is not installed')

  const missing = { ...short, path: join(directory, 'absent') }
  const missingPreparation = createPreparation({ assets: () => [complete, missing] })
  await missingPreparation.inspect()
  assert.equal(missingPreparation.snapshot().phase, 'unprepared', 'a missing file is not installed')

  const ready = createPreparation({ assets: () => [complete] })
  await ready.inspect()
  assert.equal(ready.snapshot().phase, 'standby', 'the same asset list without the fault stands by')
})

test('prepare() downloads, verifies and warms, ending at ready', async (t) => {
  const bodies = { engine: payload(32 * 1024), model: payload(48 * 1024) }
  const server = await startServer((request, response, entry) => {
    const key = String(request.url).slice(1)
    const body = bodies[key]
    if (body === undefined) {
      entry.status = 404
      response.writeHead(404)
      response.end()
      return
    }
    serveRange(request, response, entry, body)
  })
  t.after(() => server.close())

  const directory = await scratchDir('prepare-ok')
  const assets = [
    { key: 'engine', url: server.origin + '/engine', path: join(directory, 'engine'), bytes: bodies.engine.length },
    { key: 'model', url: server.origin + '/model', path: join(directory, 'model'), bytes: bodies.model.length },
  ]
  const phases = []
  let warmed = 0
  const preparation = createPreparation({
    assets: () => assets,
    warm: async () => { warmed += 1 },
  })
  preparation.subscribe(() => phases.push(preparation.snapshot().phase))

  preparation.prepare()

  assert.equal(await waitForPhase(preparation, 'ready'), 'ready')
  assert.deepEqual(await readFile(assets[0].path), bodies.engine)
  assert.deepEqual(await readFile(assets[1].path), bodies.model)
  assert.equal(warmed, 1, 'the recognizer was warmed exactly once')
  assert.ok(phases.includes('downloading'), 'the download phase was published')
  assert.ok(phases.includes('loading'), 'the load phase was published')
  assert.equal(preparation.snapshot().step, undefined, 'no step points at running work once the task is done')
  assert.deepEqual(
    preparation.snapshot().steps.map((step) => step.kind + ':' + step.status),
    ['check:complete', 'model:complete', 'verify:complete', 'load:complete'],
  )
})

test('prepare() ends failed with a message and a download reason when an asset cannot be fetched', async (t) => {
  const server = await startServer((request, response, entry) => {
    entry.status = 404
    response.writeHead(404)
    response.end()
  })
  t.after(() => server.close())

  const directory = await scratchDir('prepare-404')
  const destination = join(directory, 'model')
  const preparation = createPreparation({
    assets: () => [{ key: 'model', url: server.origin + '/missing', path: destination, bytes: 1024 }],
  })

  preparation.prepare()

  // The downloader retries a failed transfer six times with backoff, so this
  // settles about fifteen seconds later.
  assert.equal(await waitForPhase(preparation, 'failed', 40000), 'failed')
  const state = preparation.snapshot()
  assert.equal(state.message, 'HTTP 404')
  assert.equal(state.step, 'model')
  assert.deepEqual(state.download, {
    resource: 'model',
    source: 'https://huggingface.co',
    reason: 'http',
    status: 404,
  })
  assert.deepEqual(
    state.steps.map((step) => step.kind + ':' + step.status),
    ['check:complete', 'model:failed', 'verify:pending'],
  )
  assert.equal(existsSync(destination), false)
})

test('a warm-up failure fails the load step and reports the warm error', async () => {
  const directory = await scratchDir('prepare-warm-fail')
  const asset = await assetFile(directory, 'model', 4096, 'http://127.0.0.1:9/model')
  const preparation = createPreparation({
    assets: () => [asset],
    warm: async () => { throw new Error('the recognizer refused to load') },
  })

  preparation.prepare()

  assert.equal(await waitForPhase(preparation, 'failed'), 'failed')
  const state = preparation.snapshot()
  assert.equal(state.message, 'the recognizer refused to load')
  assert.equal(state.step, 'load')
  assert.equal(state.download.reason, 'unknown')
  assert.deepEqual(
    state.steps.map((step) => step.kind + ':' + step.status),
    ['check:complete', 'model:complete', 'verify:complete', 'load:failed'],
  )
})

test('cancel() during a download settles at cancelled', async (t) => {
  const body = payload(256 * 1024)
  const server = await startServer((request, response, entry) => {
    entry.status = 200
    response.writeHead(200, { 'content-length': String(body.length) })
    response.write(body.subarray(0, 1024))
    // Safety valve: the transfer only ends on its own if the cancellation under
    // test never lands, so a broken cancel fails the assertions instead of hanging.
    const bail = setTimeout(() => response.end(body.subarray(1024)), 5000)
    request.on('close', () => clearTimeout(bail))
  })
  t.after(() => server.close())

  const directory = await scratchDir('cancel')
  const destination = join(directory, 'model')
  const preparation = createPreparation({
    assets: () => [{ key: 'model', url: server.origin + '/held', path: destination, bytes: body.length }],
  })

  preparation.prepare()
  assert.equal(await waitForPhase(preparation, 'downloading'), 'downloading')

  await preparation.cancel()

  const state = preparation.snapshot()
  assert.equal(state.phase, 'cancelled')
  assert.deepEqual(
    state.steps.map((step) => step.kind + ':' + step.status),
    ['check:complete', 'model:cancelled', 'verify:pending'],
  )
  assert.equal(existsSync(destination), false)
  await preparation.cancel()
  assert.equal(preparation.snapshot().phase, 'cancelled', 'cancelling nothing leaves the state alone')
})

test('markWaking, markReady and markCold move the phase and notify subscribers', () => {
  const preparation = createPreparation({ assets: () => [] })
  const phases = []
  preparation.subscribe(() => phases.push(preparation.snapshot().phase))

  assert.deepEqual(preparation.snapshot(), { phase: 'unprepared' })
  preparation.markWaking()
  assert.equal(preparation.snapshot().phase, 'waking')
  assert.equal(typeof preparation.snapshot().startedAt, 'number')
  preparation.markReady()
  assert.equal(preparation.snapshot().phase, 'ready')
  preparation.markCold()
  assert.equal(preparation.snapshot().phase, 'standby')
  assert.deepEqual(phases, ['waking', 'ready', 'standby'])
})

test('subscribe returns a working unsubscriber and one throwing listener does not break the others', () => {
  const warnings = []
  const preparation = createPreparation({
    assets: () => [],
    logger: { warn: (message) => warnings.push(message) },
  })
  let counted = 0
  const unsubscribeThrowing = preparation.subscribe(() => { throw new Error('listener exploded') })
  const unsubscribeCounting = preparation.subscribe(() => { counted += 1 })

  assert.equal(typeof unsubscribeThrowing, 'function')
  assert.equal(typeof unsubscribeCounting, 'function')

  preparation.markWaking()

  assert.equal(counted, 1, 'the listener after the throwing one still ran')
  assert.equal(warnings.length, 1, 'the failure was reported to the logger')
  assert.match(warnings[0], /preparation listener failed: Error: listener exploded/)

  unsubscribeThrowing()
  unsubscribeCounting()
  preparation.markReady()

  assert.equal(counted, 1, 'an unsubscribed listener is not notified again')
  assert.equal(warnings.length, 1)
  assert.equal(preparation.snapshot().phase, 'ready', 'the transition still happened')
})

test('markReady and markCold are ignored while a prepare task is running', async (t) => {
  const body = payload(128 * 1024)
  let release = () => {}
  const held = new Promise((resolve) => { release = resolve })
  const server = await startServer(async (request, response, entry) => {
    entry.status = 200
    response.writeHead(200, { 'content-length': String(body.length) })
    response.write(body.subarray(0, 1024))
    await held
    response.end(body.subarray(1024))
  })
  t.after(async () => {
    release()
    await server.close()
  })

  const directory = await scratchDir('busy')
  const destination = join(directory, 'model')
  const preparation = createPreparation({
    assets: () => [{ key: 'model', url: server.origin + '/held', path: destination, bytes: body.length }],
  })

  preparation.prepare()
  assert.equal(await waitForPhase(preparation, 'downloading'), 'downloading')

  preparation.markReady()
  assert.equal(preparation.snapshot().phase, 'downloading', 'a warm recognizer cannot exist mid-download')
  preparation.markCold()
  assert.equal(preparation.snapshot().phase, 'downloading', 'the download owns the phase')

  release()
  assert.equal(await waitForPhase(preparation, 'standby'), 'standby')
  assert.deepEqual(await readFile(destination), body)

  preparation.markReady()
  assert.equal(preparation.snapshot().phase, 'ready', 'the hooks apply again once the task is gone')
  preparation.markCold()
  assert.equal(preparation.snapshot().phase, 'standby')
})

test('dispose() releases the subscribers and stops publishing', () => {
  const preparation = createPreparation({ assets: () => [] })
  let notifications = 0
  preparation.subscribe(() => { notifications += 1 })

  preparation.markWaking()
  assert.equal(notifications, 1)

  preparation.dispose()
  preparation.markReady()
  preparation.markCold()

  assert.equal(notifications, 1, 'a disposed controller notifies nobody')
  assert.equal(preparation.snapshot().phase, 'waking', 'and publishes no further state')
})

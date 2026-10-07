/**
 * Regression tests for two defects found by review in the provider kit.
 *
 * Both were live: the first made every real network failure report as unknown in
 * the preparation card, and the second replaced an accurate integrity error with a
 * misleading protocol error after fifteen seconds of retries.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify } from '../src/provider-kit/preparation.js'
import { downloadAsset } from '../src/provider-kit/http.js'

test('classify reads the cause chain, not just the top message', () => {
  // A real undici failure looks exactly like this: a generic message with the
  // diagnosis on `cause`. Reading only message classified every one as unknown.
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  assert.equal(classify(refused).reason, 'network')

  const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })
  assert.equal(classify(dns).reason, 'dns')

  const tls = new TypeError('fetch failed', { cause: Object.assign(new Error('unable to verify'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) })
  assert.equal(classify(tls).reason, 'certificate')

  const timedOut = new TypeError('fetch failed', { cause: Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) })
  assert.equal(classify(timedOut).reason, 'network')

  const full = new TypeError('fetch failed', { cause: Object.assign(new Error('no space left'), { code: 'ENOSPC' }) })
  assert.equal(classify(full).reason, 'storage')
})

test('classify still reads errors that carry no cause', () => {
  assert.deepEqual(classify(new Error('HTTP 404')), { reason: 'http', status: 404 })
  assert.equal(classify(new Error('expected 10 bytes but received 4')).reason, 'integrity')
  assert.equal(classify(new Error('something else entirely')).reason, 'unknown')
  assert.equal(classify(undefined).reason, 'unknown')
})

test('a definitive size mismatch is terminal and keeps its own diagnosis', async () => {
  const body = Buffer.alloc(65536, 7)
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    const range = request.headers.range
    if (range === undefined) {
      response.writeHead(200, { 'content-length': String(body.length) })
      response.end(body)
      return
    }
    // A range beyond the resource: exactly what the old retry loop provoked.
    const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
    if (start >= body.length) {
      response.writeHead(416)
      response.end()
      return
    }
    response.writeHead(206, { 'content-length': String(body.length - start) })
    response.end(body.subarray(start))
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  const root = await mkdtemp(join(tmpdir(), 'dsh-stt-regress-'))
  try {
    await assert.rejects(
      () => downloadAsset({
        url: 'http://127.0.0.1:' + port + '/model',
        destination: join(root, 'model'),
        expectedBytes: body.length + 5,
      }),
      // The accurate error, not HTTP 416, and it must not spend six retries.
      /expected 65541 bytes but received 65536/,
    )
    assert.equal(requests, 1, 'a size mismatch must not be retried')
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

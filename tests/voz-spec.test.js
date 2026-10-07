/**
 * Unit tests for the Voz spec: the published asset inventory, the language list,
 * and where the bundle lives on each platform.
 *
 * The path expectations are written out in full rather than derived from the code
 * under test, because the whole point of the cache layout is that it matches what
 * Voz's own platform-node.js computes - a copied constant would agree with a bug.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { isAbsolute, posix, win32 } from 'node:path'
import { test } from 'node:test'
import {
  ASSETS,
  CACHE_SEGMENTS,
  LANGUAGES,
  assets,
  createSpec,
  defaultCacheRoot,
  resolveLayout,
  workerEnv,
} from '../src/providers/voz/spec.js'

/** The 25 codes Voz accepts, in the order the bundle documents them. */
const EXPECTED_LANGUAGES = [
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu',
  'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk',
]

/** The published file names, in download order. */
const KEYS = ['meta.json', 'vocab.json', 'embedding.f16', 'encoder.onnx', 'encoder.onnx.data', 'decoder.webgpu.onnx']

/** The exact byte length of each published file, as the Hub serves it. */
const SIZES = {
  'meta.json': 539,
  'vocab.json': 78654,
  'embedding.f16': 10487040,
  'encoder.onnx': 813056,
  'encoder.onnx.data': 348981248,
  'decoder.webgpu.onnx': 24472430,
}

/** Where the bundle is published. */
const HUB = 'https://huggingface.co/desert-ant-labs/voz/resolve/main/web/'

/** A Windows machine with no cache environment set. */
const WINDOWS = { platform: 'win32', home: 'C:\\Users\\ada', env: {} }

/** The path flavor and an override root that make the closure tests portable. */
const paths = process.platform === 'win32' ? win32 : posix
const OVERRIDE = process.platform === 'win32' ? 'D:\\data\\voz' : '/data/voz'

test('declares the 25 Voz languages and never advertises auto detection', () => {
  assert.deepEqual([...LANGUAGES], EXPECTED_LANGUAGES)
  assert.equal(LANGUAGES.length, 25)
  assert.equal(LANGUAGES.includes('auto'), false)
  assert.ok(LANGUAGES.every((code) => /^[a-z]{2}$/.test(code)))
})

test('assets() names the six published files with their exact urls, sizes and paths', () => {
  const list = assets(undefined, {}, WINDOWS)
  assert.deepEqual(list.map((asset) => asset.key), KEYS)
  assert.deepEqual(list.map((asset) => asset.url), KEYS.map((key) => HUB + key))
  assert.deepEqual(list.map((asset) => asset.bytes), KEYS.map((key) => SIZES[key]))
  assert.deepEqual(list.map((asset) => asset.path), KEYS.map((key) =>
    'C:\\Users\\ada\\.cache\\desert-ant-models\\desert-ant-labs\\voz\\main\\web\\' + key))
  assert.equal(list.reduce((sum, asset) => sum + asset.bytes, 0), 384832967)
  // The kit's asset contract, field by field.
  assert.deepEqual(Object.keys(list[0]).sort(), ['bytes', 'key', 'path', 'url'])
})

test('assets() rewrites the origin for a mirror and leaves the local paths alone', () => {
  const canonical = assets(undefined, {}, WINDOWS)
  const mirror = assets('https://hf-mirror.com', {}, WINDOWS)
  assert.deepEqual(mirror.map((asset) => asset.url), canonical.map((asset) =>
    asset.url.replace('https://huggingface.co', 'https://hf-mirror.com')))
  assert.deepEqual(mirror.map((asset) => asset.path), canonical.map((asset) => asset.path))
  assert.ok(mirror.every((asset) => asset.url.startsWith('https://hf-mirror.com/desert-ant-labs/voz/resolve/main/web/')))
})

test('the asset table is the same one the worker verifies', () => {
  assert.deepEqual(ASSETS.map((asset) => asset.key), KEYS)
  assert.deepEqual(ASSETS.map((asset) => asset.bytes), KEYS.map((key) => SIZES[key]))
})

test('cache root: win32 uses the home .cache directory, or XDG_CACHE_HOME when set', () => {
  // Only darwin is special-cased by platform-node.js; the XDG variable applies
  // everywhere else, Windows included.
  assert.equal(defaultCacheRoot(WINDOWS), 'C:\\Users\\ada\\.cache')
  assert.equal(defaultCacheRoot({ platform: 'win32', home: 'C:\\Users\\ada', env: { XDG_CACHE_HOME: 'D:\\xdg' } }), 'D:\\xdg')
})

test('cache root: darwin uses ~/Library/Caches and ignores XDG_CACHE_HOME', () => {
  assert.equal(defaultCacheRoot({ platform: 'darwin', home: '/Users/ada', env: { XDG_CACHE_HOME: '/data/cache' } }), '/Users/ada/Library/Caches')
})

test('cache root: linux honours XDG_CACHE_HOME and falls back to ~/.cache', () => {
  assert.equal(defaultCacheRoot({ platform: 'linux', home: '/home/ada', env: { XDG_CACHE_HOME: '/data/cache' } }), '/data/cache')
  assert.equal(defaultCacheRoot({ platform: 'linux', home: '/home/ada', env: {} }), '/home/ada/.cache')
})

test('cache root: DAL_CACHE_ROOT wins on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const env = { DAL_CACHE_ROOT: '/chosen/root', XDG_CACHE_HOME: '/data/cache' }
    assert.equal(defaultCacheRoot({ platform, home: '/home/ada', env }), '/chosen/root')
  }
})

test('resolveLayout() appends the five segments Voz reads on every platform', () => {
  const cases = [
    [{ ...WINDOWS }, 'C:\\Users\\ada\\.cache', 'C:\\Users\\ada\\.cache\\desert-ant-models\\desert-ant-labs\\voz\\main\\web'],
    [{ platform: 'darwin', home: '/Users/ada', env: {} }, '/Users/ada/Library/Caches', '/Users/ada/Library/Caches/desert-ant-models/desert-ant-labs/voz/main/web'],
    [{ platform: 'linux', home: '/home/ada', env: {} }, '/home/ada/.cache', '/home/ada/.cache/desert-ant-models/desert-ant-labs/voz/main/web'],
  ]
  for (const [options, cacheRoot, modelRoot] of cases) {
    assert.deepEqual(resolveLayout({}, options), { cacheRoot, modelRoot })
  }
  assert.deepEqual([...CACHE_SEGMENTS], ['desert-ant-models', 'desert-ant-labs', 'voz', 'main', 'web'])
})

test('resolveLayout() treats a plain modelRoot as the cache root', () => {
  assert.deepEqual(resolveLayout({ modelRoot: 'D:\\data\\voz' }, WINDOWS), {
    cacheRoot: 'D:\\data\\voz',
    modelRoot: 'D:\\data\\voz\\desert-ant-models\\desert-ant-labs\\voz\\main\\web',
  })
  assert.deepEqual(resolveLayout({ modelRoot: '/opt/models' }, { platform: 'linux', home: '/home/ada', env: {} }), {
    cacheRoot: '/opt/models',
    modelRoot: '/opt/models/desert-ant-models/desert-ant-labs/voz/main/web',
  })
})

test('resolveLayout() accepts a modelRoot that already names the bundle directory', () => {
  const directory = 'D:\\data\\voz\\desert-ant-models\\desert-ant-labs\\voz\\main\\web'
  assert.deepEqual(resolveLayout({ modelRoot: directory }, WINDOWS), { cacheRoot: 'D:\\data\\voz', modelRoot: directory })
  assert.deepEqual(resolveLayout({ modelRoot: '/opt/models/desert-ant-models/desert-ant-labs/voz/main/web' }, { platform: 'linux', home: '/home/ada', env: {} }), {
    cacheRoot: '/opt/models',
    modelRoot: '/opt/models/desert-ant-models/desert-ant-labs/voz/main/web',
  })
})

test('workerEnv() points the child at exactly the directory assets() writes to', () => {
  const env = workerEnv({}, WINDOWS)
  assert.deepEqual(env, {
    DAL_CACHE_ROOT: 'C:\\Users\\ada\\.cache',
    DSH_STT_VOZ_MODEL_ROOT: 'C:\\Users\\ada\\.cache\\desert-ant-models\\desert-ant-labs\\voz\\main\\web',
  })
  const directories = new Set(assets(undefined, {}, WINDOWS).map((asset) => asset.path.slice(0, asset.path.lastIndexOf('\\'))))
  assert.deepEqual([...directories], [env.DSH_STT_VOZ_MODEL_ROOT])
})

test('workerEnv() carries a modelRoot override through as the cache root', () => {
  assert.equal(workerEnv({ modelRoot: 'D:\\data\\voz' }, WINDOWS).DAL_CACHE_ROOT, 'D:\\data\\voz')
  const directory = 'D:\\data\\voz\\desert-ant-models\\desert-ant-labs\\voz\\main\\web'
  assert.deepEqual(workerEnv({ modelRoot: directory }, WINDOWS), { DAL_CACHE_ROOT: 'D:\\data\\voz', DSH_STT_VOZ_MODEL_ROOT: directory })
})

test('createSpec() states the provider facts the picker renders', () => {
  const spec = createSpec()
  assert.equal(spec.name, 'Voz')
  assert.equal(spec.timeoutMs, 180000)
  assert.equal(spec.idleTimeoutMs, 300000)
  assert.ok(isAbsolute(spec.workerEntry))
  assert.ok(spec.workerEntry.endsWith('worker.js'))
  assert.ok(existsSync(spec.workerEntry))

  const info = spec.info({ id: 'voz-local' })
  assert.equal(info.id, 'voz-local')
  assert.equal(info.name, 'Voz (Desert Ant Labs, WASM/CPU)')
  assert.equal(info.location, 'host-local')
  assert.deepEqual([...info.languages], EXPECTED_LANGUAGES)
  assert.deepEqual(info.setupEstimate, {
    recommendedDiskBytes: 500000000,
    expectedMemoryBytes: 1400000000,
    minimumMinutes: 2,
    maximumMinutes: 30,
  })
  assert.deepEqual([...info.downloadSources], ['https://huggingface.co', 'https://hf-mirror.com'])
})

test('createSpec() honours name and id overrides and keeps a default id', () => {
  assert.equal(createSpec({ id: 'voz-local' }).info().id, 'voz-local')
  assert.equal(createSpec().info().id, 'voz-local')
  assert.equal(createSpec().info({ id: 'voz-2' }).id, 'voz-2')
  assert.equal(createSpec().info({ name: 'Voz (fast)' }).name, 'Voz (fast)')
})

test('createSpec(config) applies modelRoot to the download and the worker alike', () => {
  const spec = createSpec({ modelRoot: OVERRIDE })
  const expected = KEYS.map((key) => paths.join(OVERRIDE, ...CACHE_SEGMENTS, key))
  assert.deepEqual(spec.assets(undefined).map((asset) => asset.path), expected)
  assert.equal(spec.workerEnv().DAL_CACHE_ROOT, paths.resolve(OVERRIDE))
  // A call-time config still wins over the one the spec was built with.
  const other = paths.join(OVERRIDE, 'other')
  assert.equal(spec.workerEnv({ modelRoot: other }).DAL_CACHE_ROOT, paths.resolve(other))
})

/**
 * Plugin activation: which providers a configuration registers, what an override
 * reaches, where a default model root points, and what activation must never do.
 *
 * The host context is a stub, because these tests are about the wiring apply()
 * owns; nothing here starts a provider, downloads a model, or touches the network.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'

import { Config, apply, inject, name as pluginName } from '../src/index.js'
import { Config as Schema } from '../src/config.js'
import { DEFAULT_NAME, ENGINE_BYTES, ENGINE_FILE, MODEL_BYTES, MODEL_FILE } from '../src/providers/whistle/index.js'

/** The display names the shipped roster advertises, in picker order. */
const ROSTER = [
  { id: 'whistle-local', name: DEFAULT_NAME },
  { id: 'voz-local', name: 'Voz (Desert Ant Labs, WASM/CPU)' },
  { id: 'sensevoice-local', name: 'SenseVoice (coming soon)' },
]

/** Scratch root holding every temp directory this suite creates; removed on exit. */
let scratch = null

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-stt-entry-'))
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
 * A host context stub that records everything apply() does through it.
 * @returns the context, the registered providers, the effect disposers and the log.
 */
function createHost() {
  const providers = []
  const effects = []
  const logs = []
  const ctx = {
    logger: (loggerName) => ({
      debug: (message) => logs.push({ level: 'debug', loggerName, message }),
      info: (message) => logs.push({ level: 'info', loggerName, message }),
      warn: (message) => logs.push({ level: 'warn', loggerName, message }),
      error: (message) => logs.push({ level: 'error', loggerName, message }),
    }),
    effect(callback) {
      const disposer = callback()
      effects.push(disposer)
      return disposer
    },
    speechToText: {
      register(provider) {
        providers.push(provider)
        return async () => {}
      },
    },
  }
  return { ctx, providers, effects, logs }
}

/**
 * Unwind every registration apply() made, the way Cordis does on unload.
 * @param effects - the disposers the stub effect hook recorded.
 * @returns after every provider is released.
 */
async function unwind(effects) {
  for (const disposer of effects) await disposer()
}

/**
 * Create a file of exactly this many bytes without writing them.
 * @param file - the absolute path to create.
 * @param bytes - the exact length isComplete() must see.
 * @returns after the file exists at that length.
 */
async function writeExactFile(file, bytes) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, Buffer.alloc(0))
  await truncate(file, bytes)
}

/**
 * Poll a provider's preparation until it publishes one phase.
 * @param preparation - the controller to read.
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

test('the plugin advertises its name, injection and schema', () => {
  assert.equal(pluginName, 'dsh-stt')
  assert.deepEqual(inject, ['speechToText'])
  assert.equal(Config, Schema, 'the module re-exports the validated schema itself')
})

test('apply registers exactly the three built-in providers in picker order', async (t) => {
  const dataRoot = await scratchDir('roster')
  const host = createHost()

  apply(host.ctx, { dataRoot, providers: {} })
  t.after(() => unwind(host.effects))

  assert.deepEqual(host.providers.map((provider) => provider.info.id), ROSTER.map((entry) => entry.id))
  assert.deepEqual(host.providers.map((provider) => provider.info.name), ROSTER.map((entry) => entry.name))
  assert.equal(host.effects.length, ROSTER.length, 'one registration effect per provider')
  for (const disposer of host.effects) assert.equal(typeof disposer, 'function')
  for (const provider of host.providers) assert.equal(provider.info.location, 'host-local')
})

test('a provider disabled by configuration is not registered at all', async (t) => {
  const dataRoot = await scratchDir('disabled')
  const host = createHost()

  apply(host.ctx, { dataRoot, providers: { 'voz-local': { enabled: false } } })
  t.after(() => unwind(host.effects))

  assert.deepEqual(host.providers.map((provider) => provider.info.id), ['whistle-local', 'sensevoice-local'])
  assert.equal(host.effects.length, 2, 'a disabled provider leaves no registration effect')
  assert.ok(
    host.logs.some((entry) => entry.level === 'debug' && entry.loggerName === 'dsh-stt' && entry.message.includes('voz-local')),
    'the disabled provider is reported to the log',
  )
})

test('id and name overrides reach the registered provider', async (t) => {
  const dataRoot = await scratchDir('override')
  const host = createHost()

  apply(host.ctx, {
    dataRoot,
    providers: { 'whistle-local': { id: 'whistle-mirror', name: 'Whistle (local mirror)' } },
  })
  t.after(() => unwind(host.effects))

  assert.deepEqual(
    host.providers.map((provider) => provider.info.id),
    ['whistle-mirror', 'voz-local', 'sensevoice-local'],
  )
  const overridden = host.providers[0]
  assert.equal(overridden.info.name, 'Whistle (local mirror)')
  assert.equal(host.providers.some((provider) => provider.info.id === 'whistle-local'), false)
})

test('modelRoot defaults to <dataRoot>/<key>', async (t) => {
  const dataRoot = await scratchDir('default-root')
  // A complete Whistle installation in the default location: if apply() pointed
  // the model root anywhere else, the activation inspection would find nothing.
  await writeExactFile(join(dataRoot, 'whistle-local', ENGINE_FILE), ENGINE_BYTES)
  await writeExactFile(join(dataRoot, 'whistle-local', MODEL_FILE), MODEL_BYTES)
  const host = createHost()

  apply(host.ctx, { dataRoot, providers: {} })
  t.after(() => unwind(host.effects))

  const whistle = host.providers.find((provider) => provider.info.id === 'whistle-local')
  assert.equal(await waitForPhase(whistle.preparation, 'standby'), 'standby')
  const voz = host.providers.find((provider) => provider.info.id === 'voz-local')
  assert.equal(voz.preparation.snapshot().phase, 'unprepared', 'the other roots stay empty')
  const sensevoice = host.providers.find((provider) => provider.info.id === 'sensevoice-local')
  assert.equal(sensevoice.preparation.snapshot().phase, 'unprepared')
})

test('an explicit modelRoot is used instead of the default', async (t) => {
  const dataRoot = await scratchDir('override-root-data')
  const mirror = await scratchDir('override-root-mirror')
  await writeExactFile(join(mirror, ENGINE_FILE), ENGINE_BYTES)
  await writeExactFile(join(mirror, MODEL_FILE), MODEL_BYTES)
  const host = createHost()

  apply(host.ctx, { dataRoot, providers: { 'whistle-local': { modelRoot: mirror } } })
  t.after(() => unwind(host.effects))

  const whistle = host.providers.find((provider) => provider.info.id === 'whistle-local')
  assert.equal(await waitForPhase(whistle.preparation, 'standby'), 'standby')
  assert.equal(existsSync(join(dataRoot, 'whistle-local')), false, 'the default root was never used')
})

test('apply downloads nothing', async (t) => {
  const dataRoot = await scratchDir('no-download')
  const host = createHost()
  const attempted = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    attempted.push(String(url))
    throw new Error('apply() fetched ' + String(url))
  }
  try {
    apply(host.ctx, { dataRoot, providers: {} })
    // Let the disk inspections every provider starts at activation run to completion.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    globalThis.fetch = realFetch
  }
  t.after(() => unwind(host.effects))

  assert.deepEqual(attempted, [], 'activation must not fetch a model')
  assert.deepEqual(await readdir(dataRoot), [], 'activation must not write either')
  for (const provider of host.providers) {
    assert.equal(provider.preparation.snapshot().phase, 'unprepared')
  }
})

test('Config validates a dataRoot and defaults providers to {}', () => {
  const result = Config['~standard'].validate({ dataRoot: 'C:/x' })

  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value, { dataRoot: 'C:/x', providers: {} })
  assert.deepEqual(Object.keys(result.value.providers), [], 'an absent key keeps its built-in default')
})

test('Config carries a provider row through validation', () => {
  const result = Config['~standard'].validate({
    dataRoot: 'C:/x',
    providers: { 'voz-local': { enabled: false, modelRoot: 'D:/models/voz' } },
  })

  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value.providers, { 'voz-local': { enabled: false, modelRoot: 'D:/models/voz' } })
})

test('Config reports a missing or empty dataRoot as an issue', () => {
  const missing = Config['~standard'].validate({})
  assert.equal(missing.value, undefined)
  assert.ok(Array.isArray(missing.issues) && missing.issues.length >= 1)
  assert.deepEqual(missing.issues[0].path, ['dataRoot'])
  assert.match(missing.issues[0].message, /dataRoot/)

  const empty = Config['~standard'].validate({ dataRoot: '' })
  assert.equal(empty.value, undefined)
  assert.ok(Array.isArray(empty.issues) && empty.issues.length >= 1)
  assert.deepEqual(empty.issues[0].path, ['dataRoot'])
})

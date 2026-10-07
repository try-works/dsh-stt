/**
 * The advertised-but-absent SenseVoice provider: it must never look installable,
 * never fetch anything, and never offer a language the real recognizer rejects.
 *
 * The real recognizer this stands in for is DSH's own speech-to-text-sensevoice
 * package; its accepted languages are mirrored here from
 * packages/experimental/speech-to-text-sensevoice/src/input.ts, because a language
 * this placeholder advertises and the real model rejects would throw on selection.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMING_SOON, createPlaceholderProvider, languages } from '../src/providers/sensevoice/index.js'

/** The language hints DSH's real SenseVoice recognizer accepts. */
const REAL_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** The seam's default language; its registry rejects a provider that does not list it. */
const DEFAULT_LANGUAGE = 'auto'

/** The id the roster registers this placeholder under. */
const ID = 'sensevoice-local'

test('info() advertises the placeholder under the real id, location and language list', () => {
  const provider = createPlaceholderProvider({ id: ID })

  assert.equal(provider.info.id, ID)
  assert.equal(provider.info.name, 'SenseVoice (coming soon)')
  assert.equal(provider.info.location, 'host-local')
  assert.deepEqual(provider.info.languages, REAL_LANGUAGES)
  assert.deepEqual([...languages], REAL_LANGUAGES, 'the exported list is the same list')
  for (const language of provider.info.languages) {
    assert.ok(REAL_LANGUAGES.includes(language), language + ' is not a language the real recognizer accepts')
  }
})

test('the configured id and display name are adopted', () => {
  const provider = createPlaceholderProvider({ id: 'sensevoice-alt', name: 'SenseVoice (test)' })

  assert.equal(provider.info.id, 'sensevoice-alt')
  assert.equal(provider.info.name, 'SenseVoice (test)')
  assert.deepEqual(provider.info.languages, REAL_LANGUAGES, 'renaming does not change what it accepts')
})

test('the resting phase is unprepared, never ready', () => {
  const provider = createPlaceholderProvider({ id: ID })

  assert.deepEqual(provider.preparation.snapshot(), { phase: 'unprepared' })
  assert.notEqual(provider.preparation.snapshot().phase, 'ready', 'a ready model would make the microphone usable')
})

test('it satisfies the provider and preparation shape the registry requires', () => {
  const provider = createPlaceholderProvider({ id: ID })

  assert.equal(typeof provider.info, 'object')
  assert.equal(typeof provider.transcribe, 'function')
  assert.equal(typeof provider.preparation.snapshot, 'function')
  assert.equal(typeof provider.preparation.subscribe, 'function')
  assert.equal(typeof provider.preparation.prepare, 'function')
  assert.equal(typeof provider.preparation.cancel, 'function')
  assert.equal(typeof provider.preparation.subscribe(() => {}), 'function')
})

test('the default language is advertised, so selecting it cannot throw', () => {
  const provider = createPlaceholderProvider({ id: ID })

  assert.ok(
    provider.info.languages.includes(DEFAULT_LANGUAGE),
    'SpeechToText rejects a provider whose languages omit the selected language',
  )
})

test('prepare() explains instead of fetching anything', async () => {
  const provider = createPlaceholderProvider({ id: ID })
  const phases = []
  const unsubscribe = provider.preparation.subscribe(() => phases.push(provider.preparation.snapshot().phase))
  const attempted = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    attempted.push(String(url))
    throw new Error('the placeholder fetched ' + String(url))
  }
  try {
    provider.preparation.prepare()
  } finally {
    globalThis.fetch = realFetch
    unsubscribe()
  }

  const state = provider.preparation.snapshot()
  assert.equal(state.phase, 'failed')
  assert.equal(state.message, COMING_SOON)
  assert.deepEqual(attempted, [], 'nothing may be downloaded for a model that does not exist')
  assert.deepEqual(phases, ['failed'], 'the explanation was published to subscribers')

  await provider.preparation.cancel()
  assert.equal(provider.preparation.snapshot().phase, 'unprepared', 'cancelling returns to the truthful resting state')
})

test('transcribe() rejects with the coming-soon explanation', async () => {
  const provider = createPlaceholderProvider({ id: ID })

  await assert.rejects(
    provider.transcribe({ audio: new Uint8Array(64), language: DEFAULT_LANGUAGE }, new AbortController().signal),
    (error) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, COMING_SOON)
      return true
    },
  )
})

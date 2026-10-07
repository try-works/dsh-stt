/**
 * The bundle patch and the manifest must agree on the package name.
 *
 * The loader imports the patch row's `name` verbatim. When it was left as the
 * pre-publish name `dsh-stt`, startup reported only `dsh-stt (dsh-stt): failed to
 * import`, and --dump-config still looked correct, because composition validates
 * rows without resolving their modules.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('the patch registers this package under its published name', () => {
  assert.match(manifest.name, /^@[^/]+\//, 'a scoped name is expected, so the row must be scoped too')
  assert.ok(
    patch.includes("name: '" + manifest.name + "'"),
    'cordis.patch.yml must name ' + manifest.name + '; the loader imports that exact specifier',
  )
  // The bare, unscoped name is owned by a third party on npm and resolves to nothing here.
  assert.ok(
    !/name: 'dsh-stt'/.test(patch),
    'the patch must not reference the unscoped name, which does not resolve',
  )
})

test('the name the patch uses actually resolves to this package', async () => {
  // Self-reference through the `exports` map: the same resolution the loader performs.
  const loaded = await import(manifest.name)
  assert.equal(loaded.name, 'dsh-stt')
  assert.equal(typeof loaded.apply, 'function')
  assert.deepEqual(loaded.inject, ['speechToText'])
})

test('the bundle manifest points at a patch that exists', async () => {
  const declared = manifest.dsh.bundle.patch
  assert.equal(declared, './cordis.patch.yml')
  const body = await readFile(new URL('../' + declared.slice(2), import.meta.url), 'utf8')
  assert.ok(body.length > 0)
})

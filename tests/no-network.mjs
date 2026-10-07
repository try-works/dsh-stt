/**
 * Test fixture: give a worker child no network at all.
 *
 * The end-to-end test loads this through NODE_OPTIONS, which the kit passes on to
 * the child it spawns. Voz.load() fetches any bundle file it does not find on disk
 * with a single un-retried request, so making fetch throw turns "preparation really
 * pre-populated the cache" from a promise into something the test proves.
 */
globalThis.fetch = async (url) => {
  throw new Error('the worker tried to fetch ' + String(url) + ' instead of reading the prepared bundle')
}

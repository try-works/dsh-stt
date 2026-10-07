# dsh-stt — Multi-Model Local Voice Input for DSH Web

**Voz (Desert Ant Labs) + Whistle (Cactus Compute), user-selectable**

**Status:** proposal for review — **Q1 decided: insert into the composer draft; no auto-submit**
**Author:** build agent
**Date:** 2026-10-07
**Target:** DSH `0.2.0-rc.2` (source launch from `D:\deepseek-harness`), Web profile `~/.dsh/profiles/web`

---

## 1. TL;DR

`dsh-stt` is an out-of-tree DSH **bundle** that adds local voice input to the DSH Web
composer and lets you **choose which on-device model does the transcribing** — starting with the
Desert Ant Labs **Voz** and Cactus Compute **Whistle**.

Rather than hard-wiring one model, the bundle registers each model as a separate selectable
**speech-to-text provider**, so the choice is a setting rather than a fork. The seam was built for
exactly this: provider ids select exact registrations, and the shipped UI already renders a provider
picker, a language picker and per-provider preparation state.

The headline finding of this research: **DSH already ships a complete, provider-neutral
voice-input stack.** The microphone button, the recording toolbar, the waveform, the
host↔client transport, draft insertion, the setup dialog and the model-preparation UI all
exist and are already wired to a "pick a provider" seam. Exactly one piece is missing — a
provider. So `dsh-stt` is **not a new UI**: it is a set of provider implementations plus
a bundle patch composing four existing rows.

Adding a second model is therefore genuinely additive — a new adapter module and one patch row — not a
re-architecture. That is the whole point of the provider seam.

**Feasibility is verified, not assumed — for both models.** Each was run end-to-end in a plain Node
process on this Windows machine and each transcribed the same 7.62 s clip **exactly correctly** (§6.1):

| | **Whistle** | **Voz** |
|---|---|---|
| Install | **18.4 MB** | ~390 MB |
| Download | **7.6 s** | ~15 min |
| Load | **30 ms** | 6.2 s |
| Transcribe 7.6 s clip | **1.52 s** | 2.39 s |
| RSS | **116 MB** | 674 MiB-1.0 GB |
| Languages | 7 | **25** |

Whistle is the light default; Voz is the 25-language upgrade. Three real problems surfaced, each with a
concrete fix: Voz's download has no retry or resume (D8), the seam packages must not be mounted in a way
that splits module identity (D9), and Whistle's engine ships only inside a Python wheel (D11).

**Scope is settled.** The transcript is **inserted into the composer draft** for review (D4) — no
auto-submit, so no client plugin is needed and the shipped microphone UI is used unchanged. The build
is host-side providers only.

**We ride the shipped voice bundle (D3).** The provider picker turns out to be hard-keyed to that one
bundle's detail page, so `dsh-stt` enables it for the UI and adds only the models.

**SenseVoice is advertised, not delivered.** It appears in the picker as *SenseVoice (coming soon)* with
no download behind it, and hands off to the real provider with one config change when implemented (D13).

**Downloads are user-driven.** Enabling the bundle lists both models and fetches **zero bytes**. The
user picks a model in Settings and downloads only that one — 18.4 MB for Whistle, or ~390 MB if they
deliberately choose Voz (D12).

Estimated real logic: **one host-side module** (~400–500 lines, including a resumable model
downloader — see D8) plus configuration. Everything the user sees is shipped, tested DSH code.

---

## 2. What already exists (the key finding)

DSH ships a five-package experimental voice-input stack under `packages/experimental/`,
published to npm as `@deepseek-ai/dsh-experimental-*` at `0.2.0-rc.2`:

| Role | Package | Owns |
|---|---|---|
| **Service Definition** | `dsh-experimental-speech-to-text` | `ctx.speechToText` registry; resolves a provider and pins it |
| **Service Provider** | `dsh-experimental-speech-to-text-sensevoice` | local SenseVoice inference — the *only* shipped provider today |
| **Remote Consumer** | `dsh-experimental-api-speech-to-text` | authenticated browser↔host transport, `SpeechCatalog`, intake limits |
| **Browser UI** | `dsh-experimental-client-ui-voice-input` | microphone button, recording toolbar, waveform, setup dialog |
| **Bundle** | `dsh-experimental-voice-input-bundle` | composes the four rows; ships **disabled** |

The browser UI occupies the composer slot `conversation.input.activity` — described in
the slot catalog as *"compact action after the model selector; it can expand across the
toolbar while retaining the editor and submit action."* That is the microphone sitting
between the model picker and Send. It is already built.

### The seam is an intended extension point

The recorded design decision
([`2026-09-16-experimental-voice-input.md`](D:/deepseek-harness/.agents/notes/implemented/architecture/2026-09-16-experimental-voice-input.md))
made provider selection deliberately pluggable:

> "Provider ids select exact registrations. … Additional providers register with the same
> service under distinct ids; cloud recognition requires an explicit new provider and
> credential configuration."

> "The initial bundle supplies one local recognizer."

Adding Voz is therefore the **intended** extension path — no DSH core change, no forked UI,
no new slot.

### The interface we implement

```ts
// @deepseek-ai/dsh-experimental-speech-to-text/types
export interface SpeechProvider {
  readonly info: SpeechProviderInfo
  readonly preparation?: SpeechPreparation
  transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript>
}

export interface SpeechInput {
  readonly audio: Uint8Array   // canonical 16 kHz mono PCM16 WAV
  readonly language: string
}

export interface Transcript {
  readonly text: string
  readonly audioSeconds: number
  readonly inferenceSeconds: number
}
```

Registration is a Cordis effect — `ctx.speechToText.register(provider)` returns a
disposer that "rejects admission, cancels, and joins accepted work."

---

## 3. The models

Two deliberately different points on the size/coverage curve. Shipping both is the feature: the right
answer depends on the user's language and machine.

| | **Whistle** (Cactus Compute) | **Voz** (Desert Ant Labs) |
|---|---|---|
| Weights | **16.9 MB** — one `whistle.cact` file | 467 MB, 6 files |
| Total install | **18.4 MB** (+1.5 MB DLL) | ~390 MB |
| Download time (measured) | **7.6 s** | 367 MiB in **~15 min** |
| Load time (measured) | **30 ms** | 6.2 s warm |
| Transcribe 7.62 s clip (measured) | **1.52 s** (RTF 0.199) | 2.385 s (RTF 3.195) |
| **RSS (measured)** | **116 MB** | 674 MiB idle, ~1.0 GB peak |
| Languages | 7 (en, de, fr, es, it, nl, pl) | **25** |
| Language detection | ✅ detects unless you name one | ❌ none — needs a hint, else *"confident nonsense"* |
| Word timestamps | ✅ with per-word probability | ✅ ~80 ms resolution |
| License | **Apache-2.0** | *"other"* (free to 100k MAU) |
| Runtime | Cactus engine (`.cact`), C ABI via koffi | ONNX Runtime, WASM |
| Node on Windows | ✅ **verified end-to-end** | ✅ verified end-to-end |
| Extras | keyword biasing, speech embeddings | — |
| Accuracy | exact on clip 1; 1 word wrong on clip 2. No published cross-model WER | WER **7.40%** across six Open ASR sets |

**Whistle wins on every axis except language coverage.** Measured on this machine it is ~5x faster than
realtime, loads in 30 ms, uses **116 MB instead of ~1 GB** — roughly 6-8x less memory — and installs in
18.4 MB instead of ~390 MB. It also detects language, which Voz cannot. Its only real deficit is 7
languages against Voz's 25.

So: **Whistle is the default**, and **Voz is the coverage upgrade** for the other 18 languages. That is
exactly the kind of choice a provider picker exists to express.

### Why they fit the seam

Both take **16 kHz mono PCM16** — the seam's canonical format, verified in
`speech-to-text/src/wave.ts` as *"canonical 16 kHz mono PCM16 WAV"*. Neither needs resampling.
Both are on-device, matching `location: 'host-local'` and the no-silent-upload guarantee. Both are
ungated public downloads, so preparation needs no credentials.

Voz-specific details:

| Voz property | How it lines up with DSH |
|---|---|
| **16 000 Hz mono** — `SAMPLE_RATE === 16000` | The seam's canonical format is verified in `speech-to-text/src/wave.ts` as *"canonical 16 kHz mono PCM16 WAV"*. **Zero resampling.** |
| **WASM core, no native build** | `package.json` declares `desertant.wasmOnly: true`. Node runs the *same* core the browser does via `dist/VozWeb.wasm` (~46 MB) — **so it works on Windows.** |
| **Progress + caching hooks** | `Voz.load({ onProgress, cache, modelBaseUrl, revision })` maps directly onto `SpeechPreparation`. |
| **Lazy by construction** | "Nothing instantiates at import time … a page that imports `Voz` without calling `Voz.load()` pays nothing." Matches DSH's rule that *enabling* a plugin must not allocate resources. |
| **Public, ungated weights** | `huggingface.co/desert-ant-labs/voz` is `gated: false` — no token needed. Pinned revision `e11906f`. |
| **25 languages** | bg, cs, da, de, el, en, es, et, fi, fr, hr, hu, it, lt, lv, mt, nl, pl, pt, ro, ru, sk, sl, sv, uk. |

Voz's one real cost is the **467 MB download and ~1 GB resident**; the seam has the vocabulary for
that and it is surfaced honestly rather than hidden (§6, D8). Whistle inverts the trade: a trivial
download, but 7 languages and no published cross-model WER.

> **A third entry, SenseVoice.** DSH already ships a working SenseVoice provider. It is **not** wired up
> here: the picker will list it as **SenseVoice (coming soon)** so the roadmap is visible, with no
> download behind it (D13).

> **Why not just pick one?** Because the seam makes two nearly free, and the failure modes are
> complementary: Voz *"produces confident nonsense"* outside its 25 languages, while Whistle simply
> does not cover 18 of them. A user dictating in Polish is fine on either; in Greek, only Voz; on a
> locked-down laptop, only Whistle's 16.9 MB is realistic.

---

## 4. Architecture

```
 Browser (DSH Web UI)                   Host (the dsh web process)
 ────────────────────                   ──────────────────────────────────────────────
 ┌───────────────────────────┐          ┌───────────────────────────────────────────┐
 │ conversation.input.activity│          │ ctx.speechToText  (SHIPPED registry)      │
 │   🎤 VoiceInput (SHIPPED)  │          │                                           │
 │   + provider & language    │          │  ┌────────────────────┐  worker (child)   │
 │     picker (SHIPPED)       │          │  │ voz-local    (NEW) │──► Voz WASM       │
 └────────────┬──────────────┘          │  │ 25 langs, 467 MB   │    + ONNX Runtime │
              │ MediaRecorder           │  └────────────────────┘                   │
              │ → 16 kHz mono PCM16 WAV │  ┌────────────────────┐  worker (child)   │
              ▼                         │  │ whistle-local (NEW)│──► Whistle .cact  │
 ┌───────────────────────────┐ base64 WAV│ │ 7 langs, 16.9 MB   │    engine         │
 │ ctx.remote.speech         │ ─────────►│ └────────────────────┘                   │
 │   .transcribe() (SHIPPED) │          │        ▲                                  │
 └────────────┬──────────────┘          │        │ register() × N, one effect each   │
              │ Transcript { text }      └────────┼──────────────────────────────────┘
              ▼                                  │
 ┌───────────────────────────┐                    └─ the user picks the provider;
 │ inputActions.insertText() │  ← one undoable plain-text edit into the composer draft
 │   (SHIPPED)               │     SpeechSelection.providerId pins the choice
 └───────────────────────────┘
```

**Flow:** pick a model (once) → click 🎤 → record → Stop → browser encodes 16 kHz mono PCM16 WAV →
authenticated Remote call → `SpeechToText.resolve()` pins the chosen provider → that model's
worker transcribes → `{ text }` returns → `inputActions.insertText()` inserts one undoable
edit into the draft.

Every link except the two providers ships today.

### How the user chooses a model

No new UI is needed to pick a provider — the shipped seam already has the surfaces:

| Surface | What it does | Status |
|---|---|---|
| **Settings → Plugins → dsh-stt** | lists every registered provider with its name, languages, size and time estimate; saves the choice through the Settings service | SHIPPED (`plugins.bundle.config` slot) |
| **Download and prepare** | **per provider**, with real byte progress and an ordered step list | SHIPPED |
| **First-use setup dialog** | for a model that is not yet downloaded, offers *Go to setup* / *Later* | SHIPPED (`plugins.bundle.activation`) |
| **Microphone** | the composer activity; when nothing is prepared, clicking it opens guidance rather than recording or downloading | SHIPPED |

So the deliverable is the *providers*, and the picker falls out of the seam. Our only additions are the
display names, per-model language lists and honest `setupEstimate` values.

**Crucially, listing is free and downloading is opt-in.** Enabling the bundle registers both models and
fetches nothing; the user compares 18.4 MB against ~390 MB in the picker and downloads only the one
they choose. See **D12** for how that is guaranteed rather than hoped for.

### What `dsh-stt` actually adds

1. `src/index.js` — the Cordis plugin: registers **both** providers, one `ctx.effect` each.
2. `src/provider-kit/` — shared machinery: queue, cancellation, idle reclamation, resumable
   download, subprocess worker, readiness inspection, config schema (D10).
3. `src/providers/voz/` — the Voz adapter (`Voz.load({ ort })` + `transcribe`).
4. `src/providers/whistle/` — the Whistle adapter.
5. `cordis.patch.yml` — one override (selection) and one insert (our providers). The seam rows themselves come from the shipped voice bundle (D3).
6. `package.json` — `dsh.bundle.patch` so the plugin manager accepts it.

Both adapters implement the same three-member `SpeechProvider` interface; the kit does everything
else. Adding a model is one adapter file and one patch row.

### Sketch of the provider

```js
// src/provider.js  (shape, not final)
export function apply(ctx, config) {
  const recognizer = new VozRecognizer(config)     // owns Voz.load() lazily
  ctx.effect(() => {
    const dispose = ctx.speechToText.register({
      info: {
        id: config.providerId,                     // 'voz-local'
        name: 'Voz (WASM, CPU)',
        location: 'host-local',
        languages,                                 // the 25 Voz languages
        downloadSources: ['https://huggingface.co', 'https://hf-mirror.com'],
        setupEstimate: {
          recommendedDiskBytes: 500 * 1024 * 1024,
          expectedMemoryBytes: 1_300 * 1024 * 1024,
          minimumMinutes: 2, maximumMinutes: 20,
        },
      },
      preparation: recognizer,
      transcribe: (input, signal) => recognizer.transcribe(input, signal),
    })
    recognizer.inspect()                           // disk-only check; never loads
    return async () => { await dispose(); await recognizer.dispose() }
  })
}
```

And the transcript step — the WAV bytes arrive already in Voz's native format:

```js
async transcribe({ audio, language }, signal) {
  const voz = await this.instance(signal)          // lazy Voz.load({ ort })
  signal.throwIfAborted()
  const started = performance.now()
  const result = await voz.transcribe(audio)       // Uint8Array accepted directly
  return {
    text: result.text,
    audioSeconds: result.duration,
    inferenceSeconds: (performance.now() - started) / 1000,
  }
}
```

---

## 5. Design decisions

### D1 — Reuse the shipped seam rather than build our own UI ✅ recommended

| | Reuse seam | Bespoke mic UI |
|---|---|---|
| Effort | ~1 module of logic | UI + transport + recording + i18n + a11y |
| Consistency | Identical to shipped UX | Diverges |
| Maintenance | Supported extension point | We own everything |
| Risk | Coupled to a pre-stable API | Coupled to internal slots |

**Recommendation: reuse.** A bespoke UI would also mean shipping an out-of-tree *client*
bundle (`dsh.client` + `exports["./client"]` + the `/plugins` combo route) —
more moving parts for no user-visible gain.

### D2 — Transcribe on the Host, not in the browser ✅ recommended

Voz ships both a browser build (WebGPU/WebNN) and a Node build (WASM + CPU). Use **Host/Node**:

- The seam is already host-side (`location: 'host-local'`); the UI is provider-agnostic.
- Browser Voz needs a **separate 390 MB bundle** and ~1.2 GB resident *in the tab*, and needs
  Chromium 135+ / Safari 26+.
- One model instance for the whole app, not one per tab.
- Cost: Node is CPU-only ("`onnxruntime-node`'s default execution provider reaches no
  accelerator"), so slower per audio-second than a GPU browser. For dictation this is irrelevant.

### D3 — Rider on the shipped bundle ⚠️ **revised after review**

> **This reverses an earlier recommendation.** The first draft proposed a self-contained bundle that
> composed the four seam rows itself. Verification of the client code found a hard blocker, so the
> recommendation is now the opposite. The reasoning is recorded because the original choice looked
> clearly better on paper.

#### The blocker: the picker's bundle key is hardcoded

The provider picker is not a free-standing surface. It is registered into the
`plugins.bundle.config` slot **keyed to one specific bundle** — `mount.ts:45-47` passes
`key: '@deepseek-ai/dsh-experimental-voice-input-bundle'` — and the Plugins page only renders that
slot for the package being opened (`PluginManagerPage.tsx:612`, gated by
`ledger.bundles.has(openPkg.name)`). The same literal is used for the *Go to setup* navigation target
(`mount.ts:26`).

So the picker, the Download-and-prepare button and the setup prompt **only exist inside the shipped
bundle's detail page**. Our own `dsh-stt` bundle cannot host them, and mounting the shipped client
package from our bundle would leave the picker keyed to a bundle that is not in the profile — visible
nowhere, with a *Go to setup* button that navigates to nothing.

The components are not individually exported either, so we cannot import just the picker and re-key it.

#### The options

| | **(a) Rider** ✅ | **(b) Own client half** |
|---|---|---|
| Code we write | one provider module | providers **+ a full browser plugin** |
| Picker, setup dialog, mic UI | shipped | we reimplement all three |
| Extra dependency | `sherpa-onnx-node` (transitive) | none |
| Bundles to enable | two | one |
| Picker appears under | the *Voice Input* bundle page | our own page |

**Recommendation: (a) rider.** Enable `@deepseek-ai/dsh-experimental-voice-input-bundle` for the UI,
definition and Remote, and let `dsh-stt` contribute only the providers.

Option (b) is not a small delta: `conversation.input.activity` is single-occupant, so replacing the
shipped microphone means re-implementing recording, the waveform, WAV encoding, locale copy and the
preparation card. That is the large build D4 already declined once.

#### What the rider costs, honestly

The shipped bundle depends on `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice`, whose
`package.json` declares a **hard dependency on `sherpa-onnx-node@1.13.8`** — a native ONNX runtime.
The wrapper itself is only 61 KB, but its platform binary is pulled per platform. The bundle's own README
flags this: *"Installing dsh also installs sherpa-onnx-node and its platform-specific native runtime,
including ONNX Runtime, even when this bundle is disabled."*

That cost is paid **once, at install**, and it buys the entire UI. It is independent of which models are
then downloaded (D12). It is also why we do not simply leave SenseVoice enabled by default: see Q2.

#### Two ordering rules the rider must respect

1. **Our bundle must come after the voice bundle** in `dsh.profile.bundles`, because layers apply in
   list order and later layers win for a given row id.
2. **Overriding a row restates its whole config.** A patch replaces a row's entire `config` value
   rather than deep-merging, so overriding `speech-to-text` means supplying `language` as well as
   `defaultProvider` — otherwise the default is silently lost.

### D4 — Insert into the draft. **Decided: no auto-submit.** ✅

**Decision (user, 2026-10-07): the transcript is inserted into the composer draft and the user
submits it.** Auto-submit is not built, and not exposed as a config field either — the decision is
settled rather than deferred to a toggle.

This matches DSH's own recorded stance for this feature:

> "Recordings and transcripts remain transient until the user submits ordinary text.
> Recognition does not start an agent turn."

#### What this decides for the build

| | |
|---|---|
| Scope | **providers + bundle only** — no client plugin |
| UI | the shipped `VoiceInput` stays the sole occupant of `conversation.input.activity` |
| Submission path | `inputActions.insertText(text, span)` — one undoable edit, undoing nothing else |
| Auto-send | not implemented; no `autoSubmit` setting |

The consequence is that a mis-transcription can never silently start an agent turn carrying the user's
credentials and tool permissions, and the transcript stays editable — including for `@file` and
slash-command composition — before it is sent.

#### Rejected alternative, and why it was available

Auto-submit **is** technically possible: a client plugin may call `inputActions.submit()` (
`ui-conversation/src/client/contract/input.ts:241`, *"Enter submission (adjudication / claim
transaction / default sink inside)"*), with no key press or DOM click, and same-tick
insert-then-submit is safe because the editor applies edits synchronously before `submit()` reads
the draft.

But `conversation.input.activity` is declared `kind: 'single'` — exactly one occupant — so it
could not be layered onto the shipped microphone. It would require **our own client plugin replacing
the shipped `VoiceInput`**, re-implementing the recording toolbar, waveform and locale copy.
That is a materially larger build, and it contradicts both the user's choice here and DSH's stated
design. Recorded so the option is not silently reopened later.

#### Behaviour on a stale draft

The shipped occupant already handles the failure case we inherit: if the draft revision moved while
recording, `insertText` returns `false` and the transcript is **kept**, with an explicit **Insert**
button that re-captures a fresh span. Our providers never see this — it is entirely the UI's concern —
but it is why a slow transcription cannot clobber what the user typed while waiting.
### D5 — Ship plain JavaScript, not TypeScript ⚠️ build detail that matters

DSH's source launch is `node --import tsx/esm apps/cli/src/bin.ts`, which is why installed
bundles such as `@try-works/dsh-anti-slop` can declare `main: "./src/index.ts"`.
But DSH also has a **built launch mode** ("`dsh BUILT bin (node lib/bin.js, no tsx)`"),
where a `.ts` entry would fail to load.

**Recommendation:** ship plain ESM `.js` (compiled from TS at build time, or authored
directly as JS). `@try-works/dsh-versatile-design` does exactly this with
`main: "./src/index.js"`.

### D6 — Model lifecycle maps onto `SpeechPreparation`

`Voz.load()` is slow the first time. The seam already has the vocabulary, so map it honestly:

| Seam step | Voz operation |
|---|---|
| `check` | is the model present in `DAL_CACHE_ROOT`? (disk only) |
| `model` | `Voz.load({ onProgress })` — download, report real bytes |
| `load` | graph compile / warm-up |
| `verify` | a trivial self-check that the instance transcribes |

Because "merely installing or enabling a UI contribution must not allocate these resources,"
**the model is never loaded on activation** — only on explicit *Download and prepare*, or the
first transcription.

### D7 — Respect the intake limits

The Remote enforces `maxAudioBytes` (default **4 MB**) and `maxDurationSeconds`
(default **120 s**) before any provider runs. Dictation clips are far below both; no change needed.

### D8 — Own the model download ourselves ⚠️ forced by a real failure

A cold `Voz.load()` **failed during this research**: the TLS connection to the Hugging Face CDN
dropped mid-transfer after ~358 s, having delivered 130,966,742 of 348,981,248 bytes (37.5%). This was
not a one-off — a resumable retry hit **the same drop three more times** (at 98.3, 197.5 and
309.1 MiB, each preceded by a ~2 min stall). On this link the CDN reliably drops roughly every ~100 MiB.

```
TypeError: terminated
    at Fetch.onAborted (node:internal/deps/undici/undici:12141:53)
```

The cause is in the library, not our environment. `platform-node.js` → `makeFetchFile` does a
one-shot `fetch()` + `response.arrayBuffer()` per file with **no retry, no `Range` resume,
and no inactivity timeout**, then writes a temp file and renames it. So any transient drop loses the
whole transfer, and a retry restarts the 349 MB file **from zero**. Five of six files had already
cached successfully, so this is not a path or permissions problem. On a ~0.4–1.2 MiB/s link the
349 MB encoder is exposed to this for many minutes — effectively a coin flip.

This would make "Download and prepare" unreliable for real users, so the plugin should **not** rely on
`Voz.load()` to fetch. Instead:

1. In the `model` preparation step, run **our own resumable downloader** (HTTP `Range`, retry with
   backoff, byte progress) writing each file directly into Voz's cache directory.
2. Then call `Voz.load({ cache: true })`. Its `makeFetchFile` short-circuits on
   `fs.existsSync(file)`, so it **adopts the files as-is** and never hits the network.

This also gives us honest byte progress for the preparation UI (the seam wants real byte totals) and
keeps the door open for `modelBaseUrl` self-hosting or an offline/pre-seeded directory.

> ✅ **Confirmed in practice.** An external resumable downloader writing `encoder.onnx.data` into the
> same cache directory was adopted by `Voz.load()` with no re-fetch, and the subsequent
> `transcribe()` succeeded. Without it, plain `Voz.load()` never completed on this network.

### D9 — Get module identity right when mounting the seam ✅ mostly dissolved by D3

> **Update after the D3 revision.** Choosing the **rider** largely removes this problem: the shipped voice
> bundle pulls *one* consistent set of seam packages from npm, its bare-name row lets the browser half
> attach normally, and the host loads none of them independently. The file-URL machinery below is only
> needed if we ever go self-contained. Kept because the underlying hazard is real and would return.

This is the highest-risk detail in the whole design, and it is easy to get wrong silently.

**The problem.** The running DSH is a *source launch* from `D:\deepseek-harness` at
`0.2.0-rc.2`. But the *published* `@deepseek-ai/dsh-*` subpackages lag badly:
the npm `latest` of every `@deepseek-ai/dsh-experimental-*` package is
`0.1.7-alpha.1` (the matching `0.2.0-rc.2` sits on the `next` tag), and other
core packages are at `0.1.0-rc.6` / `0.0.1-rc.1`. So if our bundle pulls the seam from npm
while the host holds its own copy from the checkout, we get **two module instances** — and Cordis
services, slot registries and React contexts are all identity-based. The failure mode is not a crash;
it is a microphone that renders and does nothing.

**Why we can sidestep most of it.** The host loads the speech packages only if *some* bundle asks it
to, and the shipped voice bundle is disabled. So if `dsh-stt` is the only thing mounting those
rows, there is exactly one instance — ours. The danger is confined to packages the host *already*
loads, above all `@deepseek-ai/dsh-client-ui-conversation`, whose slot registry and Session
bindings our browser UI must share.

**The resolution, following this profile's own precedent.** The profile already mounts checkout
packages by absolute file URL, with the comment *"they are mounted here BY FILE URL into the DSH
checkout"*:

```yaml
- id: workflow-engine
  name: 'file:///D:/deepseek-harness/packages/workflow/workflow/lib/index.js'
```

Point the seam rows at the checkout's built output so our provider registers into the **host's own**
`ctx.speechToText` and the browser UI binds the **host's own** slots:

```yaml
- insert:
    - id: speech-to-text
      name: 'file:///D:/deepseek-harness/packages/experimental/speech-to-text/lib/index.js'
      config:
        defaultProvider: voz-local
    - id: dsh-stt
      name: 'dsh-stt'
      config:
        providerId: voz-local
    - id: api-speech-to-text
      name: 'file:///D:/deepseek-harness/packages/experimental/api-speech-to-text/lib/index.js'
    - id: ui-voice-input
      name: 'file:///D:/deepseek-harness/packages/experimental/client-ui-voice-input/lib/index.js'
```

Our own provider still resolves by bare name from the profile link, so it is the only thing we ship.

**⚠️ One unresolved detail — verify this first.** The browser half is discovered by scanning Loader
entries for packages declaring `dsh.client`. The cookbook states a client half attaches *"only to
the Loader row whose specifier is exactly the bare package name"*
(`docs/cookbook/adding-a-settings-card.md:58`), while the client-modules subsystem says the
*"nearest owning package manifest supplies the browser module id"* — which a file URL into the
checkout would also satisfy. I could not settle this from the code alone.

So the two candidate forms are:

| | Host identity | Browser half discovery |
|---|---|---|
| **File URL into the checkout** | guaranteed identical to host | ⚠️ uncertain |
| **Bare name pinned `0.2.0-rc.2`** | own npm copy (fine — the host loads none of these by default) | ✅ per the documented rule |

**This is the first thing to test during implementation** — it is a two-minute check (add the row, see
whether the microphone appears) and it decides the patch's final form. A hybrid is likely: bare names
for the row carrying the client half, file URLs for the host-only rows.

**Portability trade-off.** File URLs are absolute and assume a checkout at that path; a packaged DSH
install needs the bare-name form with the shared host packages declared as peers. I would ship what
matches this machine, then generalise.

### D10 — Multi-provider architecture: a thin kit, one adapter per model ✅

The seam already supports many providers ("*Additional providers register with the same service under
distinct ids*"), and the shipped UI renders the picker, the language list and per-provider preparation.
So multi-provider is a **packaging** decision inside our bundle, not a UI change.

```
dsh-stt registers:

  voz-local       SpeechProvider  ──┐
  whistle-local   SpeechProvider  ──┼──► ctx.speechToText  (one shared registry)
  <future>        SpeechProvider  ──┘         │
                                              ▼
                                   user picks in bundle details;
                                   SpeechSelection.providerId pins it

No provider falls back to another: a resolution captures one instance, and
a failure surfaces rather than silently transcribing elsewhere.
```

**Internal shape.** Almost everything is model-independent, so it lives once in a provider kit and each
model contributes only an adapter:

| Concern | Where it lives |
|---|---|
| Bounded serial queue, cancellation, idle reclamation | `provider-kit/queue.js` — shared |
| Resumable model download + progress → `SpeechPreparation` steps | `provider-kit/download.js` — shared (D8) |
| Subprocess worker lifecycle and JSON protocol | `provider-kit/worker.js` — shared (R3) |
| Config schema, readiness inspection, discovery | `provider-kit/base.js` — shared |
| **Load the model, transcribe a WAV, report duration** | `providers/voz/` and `providers/whistle/` — per model |

Each adapter is small by construction: Voz's is essentially `Voz.load({ ort })` plus
`voz.transcribe(bytes)`; Whistle's is whatever its engine call turns out to be (§D11). Adding a
third model later means one adapter file and one patch row.

**Why a subprocess worker per model, not in-process.** Voz's WASI runtime wires `proc_exit` to
`process.exit()` (R3) and a warm instance costs ~1 GB; Whistle's engine is a C/C++ blob with the same
class of risk. A worker also gives each model its own memory ceiling, lets an idle model be reclaimed
independently, and keeps one model's crash from taking the DSH host — or the other provider — down.

**Language handling differs per model and must be surfaced, not hidden.** Voz needs a language hint and
cannot detect one; Whistle detects unless told. Each adapter declares its own real coverage through
`SpeechProviderInfo.languages`, so the picker shows what *that model* supports rather than a union
that would mislead a user into picking Whistle for Greek.

### D11 — The Whistle adapter: three verified routes, pick the isolated one ✅

Whistle has **no npm package and no JavaScript SDK** — confirmed absent: `cactus-needle`,
`cactus-js`, `@cactus-compute/*`, `node-cactus` and others all 404, and the
similarly-named `needle-js` is an unrelated Angular library.

Its engine and weights are published on **Hugging Face**, at `huggingface.co/Cactus-Compute/needle3`.
Two URL traps worth recording: `github.com/Cactus-Compute/needle3` **404s** — there is no such
repository, and the source lives at `github.com/cactus-compute/needle` — and the HF repo is the
**only** distribution channel, since there are no GitHub Releases.

The HF repo carries **19 platform folders**, each with a binary, `libneedle.a` and `needle.h`:
`windows-x86_64`, `windows-arm64`, `linux-x86_64`, `linux-arm64`, 
`macos-arm64`, `android-*`, `ios-*`, `wasm`, plus `python`.
That breadth is a real portability asset for a plugin meant to run wherever DSH runs.

Three routes were each **run successfully on this machine**. All produced correct transcripts.

| Route | Speed | Isolation | Extra deps | Verdict |
|---|---|---|---|---|
| **`needle.exe` child process** | native | ✅ separate process | none | ✅ **recommended** |
| koffi FFI, in-process (`libneedle3.dll`) | native, fastest | ❌ a segfault kills the host | koffi | fast path, not default |
| Emscripten WASM (`wasm/needle.js` + 923 KB `.wasm`) | ~4.5x slower | ✅ no native code | none | portable fallback |

#### Recommended: drive `needle.exe` as the worker

The HF repo publishes `windows-x86_64/{needle.exe, libneedle.a, needle.h}` and a
`windows-arm64/` equivalent. Running it directly was verified:

```sh
needle.exe --model whistle.cact --audio clip.wav --audio-word-timestamps
```

This is the best fit for our architecture for three reasons. It gives **native speed with real process
isolation** — which is exactly the subprocess-worker shape D10 already commits to, so Whistle and Voz
share one worker abstraction. It needs **no FFI and no extra dependency** in the host process. And a
crash, an OOM or a hang is contained and reclaimable, which the in-process routes cannot promise.

Note the HF repo ships only a **static** `libneedle.a`, which cannot be FFI-loaded; the usable
`.dll` comes from the Python wheel (next section). Using `needle.exe` avoids that distribution
oddity entirely — a clean argument for it over koffi.

#### The other two routes, and when we would use them

**koffi FFI** was also verified working, and DSH happens to bundle koffi 3.1.1 already. The loadable
DLL is inside the Python wheel `cactus_needle-3.2.0-py3-none-win_amd64.whl` (696 KB) at
`needle/libneedle3.dll` (1,524,736 B). The C API from `needle.h`:

```c
int  needle_load(const uint8_t *cact, uint64_t len);
int  needle_transcribe(const float *pcm, int n_samples,
                      const char *language, const char *keywords,
                      int word_timestamps, char *out, int out_cap);
int  needle_models(void);          // 2 == NEEDLE_SPEECH
const char *needle_last_error(void);
```

It is meaningfully faster in-process (309 ms cold / 233 ms warm on a short clip, versus ~1.5 s for the
7.62 s clip through the child process). Keep it as a **later opt-in** for users who want minimum
latency and accept running native code in the host — not as the default, because it forfeits R11's
protection.

Two adapter details matter for this path: `needle_transcribe` takes **float32 PCM samples, not a
WAV container** (strip the 44-byte header, convert int16 → float32 — no resampling needed), and it
writes into a caller-supplied buffer, so a short return means truncation, not success.

**WASM** (`wasm/needle.js` is CJS exporting `createNeedle`, plus a 923 KB `.wasm`) also
ran correctly under Node and is the vendor's documented cross-platform route. It is ~4.5x slower, so it
is the fallback if a user's platform has no prebuilt binary or blocks native execution.

#### A hard engine constraint that shapes the design

`needle.h` states it plainly: *one process-global, non-thread-safe model per kind*. Only **one** model
instance can exist per process, and **calls must be serialized**.

That is not a limitation to work around — it confirms the design already chosen. The provider kit's
bounded serial queue (D10) is exactly the required shape, and it is now a **correctness** requirement
rather than a performance preference: concurrent `transcribe` calls into one engine would corrupt
state. It also rules out running two Whistle instances to serve two sessions at once.

Two related findings worth recording:

- **A streaming API exists** — `needle_stream_transcribe_process` and `needle_stream_transcribe_stop`.
  Out of scope here, because the seam takes one complete recording, but it is the hook for live
  captions later.
- **The `wasm-component` build is a dead end for ASR.** `needle.component.wasm` (4.5 MB, WASI P2)
  exports only `load`/`init`/`complete`/`embed`/`reset` — no `transcribe`.
  Use the plain `wasm/` folder instead if the WASM route is ever needed.

Also recorded: the engine's DLL depends only on UCRT and `kernel32`, so it is self-contained and
ships no MinGW runtime beside it.

#### One privacy note that argues for the native route

The **Python** package prints, on import, that it *collects anonymous usage counts* unless
`NEEDLE_TELEMETRY=0` is set. Our chosen routes never involve Python, so this does not affect us — but
it is a further reason to prefer `needle.exe` or the DLL over the Python bridge for a feature whose
entire premise is that audio stays on the machine.

#### Accuracy, stated honestly

On the shared 7.62 s fox clip Whistle returned the transcript **exactly**, matching Voz word for word.
On a second synthesized clip it produced *"Turn off the kitchen lights and set the thermestat to 21
degrees."* — one error: **"thermestat"** for **"thermostat"**. That is a fair picture of a 16.9 MB model
on clean synthetic speech, and one more reason the transcript lands in an editable draft rather than
being sent automatically (D4).

### D12 — Choose first, download after: lazy per-model download ✅ already supported

**Yes — and the seam does it per provider by construction, so choosing Whistle downloads only Whistle.**
Nothing is fetched when the bundle is enabled or when a provider is registered.

#### Why it works that way

`SpeechToText.prepare()` takes an **explicit provider id** and forwards to that one provider's own
preparation task (`speech-to-text/src/index.ts:158-162`):

```ts
prepare(id: SpeechProviderId, options?: SpeechPreparationOptions): void {
  const registration = this.providers.get(id)
  if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
  registration.provider.preparation?.prepare(options)
}
```

`cancelPreparation(id)` is per provider too, and each registration subscribes to its own provider's
readiness. There is no global "prepare everything" path, so a second model is never a side effect of
preparing the first.

#### The flow the user sees

| Step | What happens | Bytes downloaded |
|---|---|---|
| Enable the `dsh-stt` bundle | both providers **register** and report `phase: 'unprepared'` | **0** |
| Open Settings → Plugins → **Voice Input** | the picker lists each model with its name, languages and `setupEstimate` (`PreparationCard.tsx:146-149`) | **0** |
| Choose a model | selection persists through the Settings service | **0** |
| Click **Download and prepare** | `prepare(providerId)` runs for **that provider only** | 18.4 MB *or* ~390 MB |
| Click 🎤 and record | `transcribe()` goes to the chosen provider | 0 |

Clicking the microphone while nothing is prepared **does not download** — it opens guidance whose
action navigates to bundle details. That is the shipped behaviour the design note describes: *"Before
recognition is ready, guidance appears only on click"* and the action *"opens the voice bundle details
without recording or downloading"*.

#### What our plugin must do to get this (three requirements)

1. **Never download in `apply()`.** Activation may only *inspect disk*. For Voz that means calling
   `fs.existsSync` on the cache directory, **never** `Voz.load()` — because `Voz.load()` is what
   fetches 367 MiB. Whistle is the same: check for `needle.exe` and `whistle.cact`.
2. **Always expose a `preparation` object.** The registry treats a provider with no `preparation` as
   permanently `phase: 'ready'` (`speech-to-text/src/index.ts:125`). If we omitted it, the UI would
   show a ready microphone and the **first transcription** would silently trigger the download — exactly
   the behaviour we are trying to avoid. Our providers therefore must report `'unprepared'` until the
   model is actually on disk.
3. **Populate `setupEstimate` and `downloadSources` honestly.** These are what let a user make an
   informed choice *before* committing — 18.4 MB and seconds for Whistle, ~390 MB and a quarter of an
   hour for Voz. The estimates we publish:

```js
// whistle-local
setupEstimate: { recommendedDiskBytes: 20 * 1024 * 1024,
                 expectedMemoryBytes: 200 * 1024 * 1024,
                 minimumMinutes: 0, maximumMinutes: 2 }
// voz-local
setupEstimate: { recommendedDiskBytes: 500 * 1024 * 1024,
                 expectedMemoryBytes: 1_300 * 1024 * 1024,
                 minimumMinutes: 2, maximumMinutes: 30 }   // measured: ~15 min on this link
```

#### Two edge cases worth handling explicitly

- **Disabling a provider means it never appears.** With `enabled: false` in our config map (D10) the
  provider is simply never registered, so it cannot be selected *or* downloaded. That is the strongest
  form of "don't download it".
- **Switching providers can conflict with the saved language.** `configure()` validates the language
  against the newly selected provider and **throws** if it is unsupported
  (`speech-to-text/src/index.ts:144-151`). Whistle covers 7 languages and Voz 25, so a user on
  Greek who switches to Whistle would hit this. The adapter-level `languages` lists must therefore be
  exact, and the switch should be a single `configure({ providerId, language })` patch rather than two
  calls that can half-apply.

### D13 — SenseVoice as a **coming soon** entry in the picker ✅ decided

**Decision (user, 2026-10-07): show SenseVoice in the model picker labelled as coming soon, and do not
wire up its download.** It is advertised, not delivered — no preparation path, no bytes fetched.

#### How the label gets there

The picker and the card heading both render the provider's **display name** verbatim: the option label is
`{provider.name}` (`PreparationCard.tsx:146-149`) and the card heading is
`<strong>{provider.name}</strong>` (`:73`). So a registered provider whose name is
`SenseVoice (coming soon)` puts the copy exactly where users look, with **no client plugin and no UI
fork** — which is the whole point.

#### The stub

```js
// providers/sensevoice-placeholder.js — advertised only; nothing downloads
ctx.speechToText.register({
  info: {
    id: 'sensevoice-local',            // stable id, so a later real provider inherits the selection
    name: 'SenseVoice (coming soon)',
    location: 'host-local',
    languages,                          // the real model's list, so selecting it never throws
  },
  preparation: {
    snapshot: () => ({ phase: 'unprepared' }),
    subscribe: () => () => {},
    // Not wired: explain instead of fetching anything.
    prepare: () => { state = FAILED_MESSAGE },
    cancel: async () => {},
  },
  transcribe: async () => { throw new Error('SenseVoice is not available yet.') },
})
```

#### Why this shape, precisely

The shipped preparation state machine has **no "unavailable" phase** — the phases are
`unprepared`, `checking`, `downloading`, `loading`, `waking`, `ready`, 
`standby`, `cancelling`, `cancelled` and `failed`. Each renders a specific string, so the
stub has to pick the least-wrong one. The constraints:

| Requirement | How it is met |
|---|---|
| No download offered at rest | `unprepared` is the truthful state — nothing is on disk |
| No false "ready" | never reports `ready`/`standby`, so the mic stays **not usable** and opens the
  setup dialog instead of trying to record |
| Explanatory, not silent | clicking **Download and prepare** moves it to `failed` carrying our own
  message, so the card reads *"Preparation failed: SenseVoice is coming soon…"* rather than doing nothing |
| Selection never throws | `languages` carries the real list, because `configure()` and `resolve()` reject a
  provider that does not accept the current language (`speech-to-text/src/index.ts:144-151`) |

The honest limitation: a stub is rendered through a state machine that was not designed for
"advertised but absent", so the prepare button does something other than prepare. That is a deliberate
trade — a few lines of host code and no client half — and it disappears the moment SenseVoice is wired
up for real.

#### The later hand-off is one config change

The stub uses the id `sensevoice-local` **on purpose**, matching the real package's default
`providerId`. So when SenseVoice is implemented later:

1. Set the stub's `enabled: false` in our config map (it stops registering).
2. Delete the `- id: speech-to-text-sensevoice` `disabled: true` override so the real provider registers.

The id is unchanged, so any user who had already selected it keeps their selection — and
`register()` fails loudly on a duplicate id (`speech-to-text/src/index.ts:65`), so an
accidental double-registration during the transition cannot pass silently.

---

## 6. Risks and unknowns

| # | Risk | Severity | Mitigation / status |
|---|---|---|---|
| R1 | **Voz: ~1.0 GB resident, ~384 MB download** per warm instance | High | Idle reclamation (drop after `idleTimeoutMs`); accurate `setupEstimate`; never load on enable. See §6.1 for measured numbers. |
| R2 | **Voz in Node on Windows x64** | ~~High~~ **RESOLVED** | ✅ **Verified end-to-end.** Loads and transcribes correctly, CPU-only, in a plain Node process (see §6.1). No browser needed. |
| R3 | **A Voz core abort would kill the DSH host process** | **High** | `dist/platforms/node.js` wires the WASI `proc_exit` import straight to `process.exit(code)` with no `onExit` hook. Combined with ~670 MiB–1.0 GB RSS per instance, this makes the **subprocess worker mandatory**, not optional — mirroring the shipped provider. |
| R4 | **Pre-stable API churn** (`@deepseek-ai/dsh-experimental-*`) | Medium | Pin exact `0.2.0-rc.2`; the plugin manager reports `incompatible-version` loudly rather than failing silently. |
| R5 | Peer range must satisfy the **compatibility gate** at runtime `0.2.0-rc.2` | Low | ✅ Understood, and sharper than expected. Only peers named `@deepseek-ai/dsh*` are checked, and against a **prerelease** runtime: `^0.2.0` and `^0.1.0-rc.5` both **fail**; exact `0.2.0-rc.2` and `*` pass. Safest is **no DSH peers at all**, which is what `@try-works/dsh-role-model` does. A failing bundle is skipped whole (visible in stderr), not silently half-loaded. |
| R6 | Voz **does not detect language**; out-of-set input yields "confident nonsense" | Low | Seam carries a language hint. Pairing with Desert Ant **Ear** is a possible follow-up. |
| R7 | Accuracy on real speech (WER ~10–13% on meetings/podcasts) | Low | Expected for dictation; the reviewable draft (D4) is precisely the mitigation. |
| R8 | **Voz's Node downloader has no retry, no resume and no timeout** — confirmed by a failed cold load | **High** | See D8. A transient TLS drop aborted a 349 MB transfer at 37.5% and **restarted from zero** on retry. We must own the download in our `model` preparation step. |
| R9 | **Module/class identity skew** between the checkout host and npm-published seam packages | **High** | See D9. Published `@deepseek-ai/dsh-experimental-*` is `0.1.7-alpha.1` while the host runs `0.2.0-rc.2` from source. Two instances would mean a microphone that renders and does nothing. Mount the seam by file URL into the checkout. |
| R10 | **Whistle's engine is distributed oddly** | Low | See D11. The HF repo ships only a **static** `libneedle.a`; the loadable `.dll` exists only inside a Python wheel. **Avoided entirely** by driving the published `needle.exe` instead. |
| R11 | **A native crash in Whistle's engine cannot be caught from JavaScript** | Low (was Medium) | Mitigated by choosing the `needle.exe` child-process route (D11): a segfault, OOM or hang is contained. Re-escalates only if we adopt the faster in-process koffi path — which is why that stays opt-in. |
| R12 | **Whistle covers 7 languages to Voz's 25** | Low | By design — it is why both ship. The picker must show each model's real coverage (D10) so nobody picks Whistle for Greek. |
| R13 | Whistle accuracy on non-synthetic speech | Medium | Only clean synthetic TTS clips were tested (one word wrong on the second). Whistle is a 16.9 MB model with no published cross-model WER, so real-world dictation quality is **unmeasured**. Mitigated by the reviewable draft (Q1), not by hoping. |

### 6.1 Measured evidence — both models, end-to-end on this machine

**Both models were verified working end-to-end** in plain Node processes on Windows x64
(Node v24.11.0, i7-10875H, CPU only, no browser, no GPU). Both transcribed **the same input file**: a
16 kHz mono PCM16 WAV, 7.620 s, 243,886 B. **Both produced the identical, fully correct transcript:**

> "The quick brown fox jumps over the lazy dog. Speech recognition converts spoken words into written text."

#### Head to head

| | Whistle | Voz |
|---|---|---|
| Install footprint | **18.4 MB** | ~390 MB |
| One-time download | **16,919,407 B in 7.6 s** | 384,832,967 B in ~15 min |
| Model load | **29.6-31.5 ms** | 6.2 s (warm cache) |
| Transcribe call | **1,519 ms** (cold), 1,647-1,775 ms (warm) | 2,385 ms |
| Realtime factor | **0.199** (~5.0x faster than realtime) | 3.195 |
| Process RSS | **115-116 MB** | 674 MiB idle / 890-1002 MiB peak |
| Transcript accuracy | exact | exact |
| Language detection | auto-detected `"en"` | not attempted |

#### Voz detail

| Measurement | Value |
|---|---|
| Cold download | **367 MiB** over 6 files; ~15-16 min on this link |
| Warm-cache `Voz.load()` | **6.2 s** |
| RSS after load | **674 MiB** (66 MiB before) |
| `transcribe()` of 7.62 s audio | **2.385 s** — `realtimeFactor 3.195` |
| RSS after transcribe (peak) | **890-1002 MiB** |
| Transcript | *"The quick brown fox jumps over the lazy dog. Speech recognition converts spoken words into written text."* — exact |
| Word timings | 17 words, e.g. "recognition" 3.84-4.48, "text." 6.64-6.74 |
| `Float32Array` input | also correct (2.506 s, RTFx 3.041, identical text) |
| Two in-process instances | 1190 MiB after load / 1407 MiB after transcribe — argues for one shared worker |

Supporting detail observed while validating R2:

| Measurement | Value |
|---|---|
| `onnxruntime-node` | `1.30.0` — installs in 2 min; `InferenceSession` and `Tensor` present |
| Voz package | `@desert-ant-labs/voz@3.6.0`, WASM-only, `dist/VozWeb.wasm` about 46 MB |
| `onProgress` accuracy | ⚠️ misleading — reports 100% after the first 539-byte file, then 33/50/67/83% as the denominator grows. **Do not use it as the UI's byte progress**; D8's own downloader supplies that instead. |
| Files fetched | `meta.json` 539 B, `vocab.json` 79 KB, `embedding.f16` 10.5 MB, `encoder.onnx` 813 KB, `encoder.onnx.data` 349 MB, `decoder.webgpu.onnx` 24.5 MB |
| Total over the wire | **384,832,967 B (367 MiB)**, matching the source's own 390 MB figure |
| Observed throughput | ~1.0-1.2 MiB/s while healthy, with ~2 min stalls at each drop |
| Cold-load outcome | ⚠️ **failed at 361 s** — TLS drop at 37.5%; the resumable retry hit **the same drop 3 more times** (98.3, 197.5, 309.1 MiB) and finished only via HTTP `Range`. See D8. |
| Final cold download | 348,981,248 B in **896 s (14.9 min)** once resumed |
| Cached | 5 of 6 files cached fine without help |
| Cache location | `%USERPROFILE%/.cache/desert-ant-models/desert-ant-labs/voz/main/web/` (`DAL_CACHE_ROOT` / `XDG_CACHE_HOME` override it) |

#### Whistle detail

| Measurement | Value |
|---|---|
| Model | `whistle.cact` 16,919,407 B (Apache-2.0, `gated: false`) |
| Weights we do **not** need | `checkpoints/whistle.safetensors` is 220,618,620 B — the full-precision training
  checkpoint. Fetching only `whistle.cact` + `config.json` (603 B) keeps the install at 16.9 MB. |
| `config.json` confirms | `sample_rate` 16000, `max_audio_seconds` 30, 7 languages, `weights_version` 2.0.0 |
| Engine (recommended route) | `needle.exe` 1,563,136 B, from `Cactus-Compute/needle3` on Hugging Face |
| Engine (FFI route) | `libneedle3.dll` 1,524,736 B, extracted from the `win_amd64` Python wheel |
| `needle_load` | 29.6-31.5 ms, returns 0; `needle_models()` → 2 (`NEEDLE_SPEECH`) |
| Input | 121,920 float32 samples (int16 PCM converted) |
| Word timestamps | returned with per-word probability (e.g. "quick" p=0.407, most >0.98) |
| FFI in-process, short clip | **309 ms cold / 233 ms warm** |
| WASM in Node | 1,385 ms — correct, but ~4.5x slower than FFI |
| Cold start incl. download | ~11 s download + 1.6 s first run |
| Toolchain needed | **none** — no cmake, no g++, no MSVC on this machine, and none required |
| Second clip accuracy | *"Turn off the kitchen lights and set the thermestat to 21 degrees."* — one error ("thermestat" for "thermostat") |

**Three design consequences worth flagging.**

1. **Memory is a per-model property, not a constant.** Voz costs **674 MiB idle and up to ~1.0 GB after a
   transcribe**; two in-process Voz instances reached 1407 MiB. Whistle costs **116 MB flat**. A shared,
   idle-reclaimed worker per model is the right shape — and it means a Whistle-only user never pays Voz's
   memory, which is a concrete argument for `enabled: false` per provider rather than one blob.
2. **Process safety makes the subprocess worker mandatory.** Voz's `dist/platforms/node.js` wires the
   WASI `proc_exit` import straight to `process.exit(code)` with no `onExit` hook, so a core
   abort would take the whole DSH host down. Whistle's DLL carries the same class of risk through FFI —
   a segfault in native code is not catchable from JavaScript at all. Isolation is the only real
   defence, and it matches what the shipped SenseVoice provider already does (R3).
3. **Whistle changes the first-use story completely.** 18.4 MB and 7.6 s versus ~390 MB and ~15 min. 
   The preparation UI, the setup estimate and the default-provider choice should all be built around
   that, with Voz as the deliberate opt-in upgrade.

---

## 7. Proposed package layout

```
D:\DEV\dsh-stt\
├── package.json            # dsh.bundle.patch (the only required dsh field)
├── cordis.patch.yml        # seam rows + one row per provider; defaultProvider
├── README.md
└── src\                    # plain ESM JavaScript (see D5). Host-side only — no client half (D3).
    ├── index.js            # Cordis plugin: registers every configured provider
    ├── config.js           # schemastery Config (providers map, default, limits, timeouts)
    ├── provider-kit\       # model-independent, shared by every adapter (D10)
    │   ├── base.js         #   SpeechProvider scaffolding + readiness inspection
    │   ├── queue.js        #   bounded serial queue, cancellation, idle reclamation
    │   ├── download.js     #   resumable model fetch → SpeechPreparation steps (D8)
    │   └── worker.js       #   child-process lifecycle + JSON protocol (R3)
    ├── providers\
    │   ├── voz\            #   Voz adapter + its worker entry
    │   ├── whistle\        #   Whistle adapter (drives the needle.exe child process)
    │   └── sensevoice\     #   placeholder only: advertises, never downloads (D13)
    └── locales\            #   provider display names and setup copy
```

Each `providers/<model>/` directory is small: load the model, transcribe a WAV, report the
duration. Everything around it — preparation, queueing, cancellation, memory reclamation, crashing
safely — is written once in `provider-kit/`.

### Package manifest (shape)

```jsonc
{
  "name": "dsh-stt",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.js",
  "exports": {
    ".": "./src/index.js",
    "./src/*": "./src/*",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["cordis.patch.yml", "src", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "@desert-ant-labs/voz": "3.6.0",
    "onnxruntime-node": "^1.30.0"
    // No Whistle dependency: its engine (needle.exe) and weights (whistle.cact) are
    // fetched at prepare time, not installed as npm packages (D11).
    // koffi is an OPTIONAL extra, needed only for the faster in-process route.
  },
  "devDependencies": {
    // types only; the runtime instances arrive with the shipped voice bundle (D3/D9)
    "@deepseek-ai/dsh-experimental-speech-to-text": "file:D:/deepseek-harness/packages/experimental/speech-to-text",
    "@deepseek-ai/cordis": "file:D:/deepseek-harness/vendor/cordis"
  }
}
```

Manifest notes, from the authoring guide and the runtime behaviour:

- `dsh.bundle.patch` is the **only** required bundle field. `dsh.profile.bundles` belongs to the
  *profile* manifest, never to the bundle.
- **Declare no `@deepseek-ai/dsh*` peers** (the `@try-works/dsh-role-model` precedent). Every such peer is checked against the
  **prerelease** runtime `0.2.0-rc.2`, where `^0.2.0` and `^0.1.0-rc.5` both fail while exact
  pins and `*` pass. Declaring none avoids the gate entirely; the seam packages arrive with the
  shipped voice bundle instead (D3).
- DSH packages needed only for **typechecking** go in `devDependencies` as
  `file:D:/deepseek-harness/packages/...` — the pattern `@try-works/dsh-paper-design` uses, and
  necessary because the published subpackages lag the checkout.
- Independently versioned third-party dependencies (`@desert-ant-labs/voz`,
  `onnxruntime-node`) stay under `dependencies`. **Whistle contributes none** — its engine
  and weights are downloads managed by the preparation step, not packages. A `link:` dependency uses the whole
  directory and keeps its own `node_modules`, so Voz and ONNX Runtime resolve from the package;
  `files` only matters for npm/tarball publishing.
- `packages/boot/app-boot/src/plugin-compatibility.ts:61-88` owns the gate; an exemption lives in the
  profile's `compatibility.json` as an exact `name@version` → runtime list and should not be needed here.

### Bundle patch (shape)

Because `dsh-stt` is a **rider** (D3), it does not re-declare the seam rows. The shipped voice
bundle already inserts `speech-to-text`, `speech-to-text-sensevoice`, `api-speech-to-text` and
`ui-voice-input`. Our layer does two things: **override the selection row**, and **add our providers**.

```yaml
# dsh-stt/cordis.patch.yml

# 1. Point the shared registry at our model instead of sensevoice-local.
#    A patch replaces a row's ENTIRE config, so `language` must be restated (D3).
- id: speech-to-text
  config:
    defaultProvider: whistle-local
    language: auto

# 2. Contribute the providers. One row; each model is a config key (D10).
- insert:
    - id: dsh-stt
      name: 'dsh-stt'            # resolves to main; a subpath ('dsh-stt/src/…') also works
      config:
        dataRoot: !!js dshHomePath('speech-to-text', 'dsh-stt')
        providers:
          whistle-local:
            enabled: true          # registers and is listed; downloads NOTHING until prepared
            modelRoot: !!js dshHomePath('speech-to-text', 'dsh-stt', 'whistle')
          voz-local:
            enabled: true          # ditto — 390 MB is fetched only if the user chooses Voz
            modelRoot: !!js dshHomePath('speech-to-text', 'dsh-stt', 'voz')
          sensevoice-local:
            enabled: true          # placeholder only: listed as 'coming soon', never downloads (D13)
```

Both ship `enabled: true` so both appear in the picker — and **neither downloads anything until the
user selects it and clicks Download and prepare** (D12). `enabled: false` goes further and removes a
model from the picker entirely, so it can never be chosen or fetched.

The **real** SenseVoice provider is switched off, so it is the placeholder that occupies the name (D13):

```yaml
- id: speech-to-text-sensevoice
  disabled: true          # the placeholder stands in until this is implemented
```

> **Bundle ordering matters.** `dsh-stt` must appear **after**
> `@deepseek-ai/dsh-experimental-voice-input-bundle` in `dsh.profile.bundles`, because layers apply
> in list order and a later layer wins for a given row id. Installing the voice bundle first makes this
> automatic, since installation appends.

> **One row for the plugin, a map for the models.** Enabling, disabling or re-pointing a model never
> means editing rows, and adding a third model is one adapter plus one config key.
One row for the plugin, and a `providers` map inside its config — so enabling, disabling or
re-pointing a model never means editing rows, and adding a third model is one adapter plus one config
key.

Both ship `enabled: true` so both appear in the picker — and **neither downloads anything until the
user selects it and clicks Download and prepare** (D12). `enabled: false` goes further and removes a
model from the picker entirely, so it can never be chosen or fetched.

### Install path

Two packages, in this order — the voice bundle supplies the UI and seam (D3), then ours adds the models:

```sh
# 1. the shipped seam + microphone UI
dsh plugin --profile web add @deepseek-ai/dsh-experimental-voice-input-bundle

# 2. our providers (must come AFTER the line above: later layers win per row id)
dsh plugin --profile web add ./dsh-stt        # or: add D:/DEV/dsh-stt

dsh --profile web --dump-config              # verify: a '# == dsh-stt' layer after the voice layer
```

Or use the Web **Plugins** page for both. Enabling the voice bundle first also makes the picker render,
since that is the bundle page the picker is keyed to.

Or, equivalently, the Web **Plugins** page / `plugin_manager` tool, which accepts a local
path. This is already proven in this profile: `@try-works/dsh-role-model` is installed as
`link:D:/DEV/role-model/packages/dsh-role-model`, and nine third-party bundles are present.

> **Bundle-only rule.** The plugin manager installs **bundles only**. A package without a
> `dsh.bundle` declaration is refused with `not-a-bundle` before pnpm runs
> (`packages/boot/plugin-manager/src/index.ts:410`). This is exactly why `dsh-stt` must ship the
> bundle manifest rather than being a bare plugin package.

> **Browser halves from out-of-tree bundles are proven here.** Five installed third-party bundles
> already ship a client half via `dsh.client` + `exports["./client"]` —
> `@try-works/dsh-memory`, `dsh-recursive-mode`, `dsh-righthand`, 
> `dsh-browser-agent` and `dsh-role-model` — and are running in this GUI. So the
> mechanism is available if we later want our own browser contribution. **We do not need one for the
> recommended design**, because we reuse the shipped UI.

> **Layer order and override semantics.** Layers apply: each bundle in `dsh.profile.bundles` order,
> then the profile's `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch` overlays.
> A patch replaces a row's **entire** `config` value rather than deep-merging keys, so any row we
> insert must restate every key it needs.

---

## 8. Non-goals

- No always-on microphone, wake word, or streaming partial captions.
- No speech synthesis.
- No cloud provider (and by the seam's design, **no fallback that could silently upload audio**).
- **No automatic send (D4, decided).** The transcript is inserted into the draft and the user submits
  it. No send is triggered on the user's behalf, and no `autoSubmit` switch exists to enable one.
- **No automatic model switching.** We never silently pick a different model because one failed or
  lacks a language; the user's selection is pinned or the request fails loudly.
- No changes to the DSH agent loop or any Session event: recognition stays outside model requests.
- No modification of the DSH checkout — this is an out-of-tree package.
- Not a model hub: three or four well-chosen local models, not a plugin marketplace.

---

## 9. Verification plan

1. **Unit** — registration/disposal, WAV intake, cancellation, queue bound, idle reclamation,
   preparation step progression.
2. **Real inference** — one 16 kHz mono WAV through the real provider, asserting text and
   measured durations.
3. **End-to-end in the running GUI** — enable the bundle at `http://127.0.0.1:3080`,
   confirm the 🎤 appears between the model selector and Send, record, Stop, and confirm the
   transcript lands in the draft as one undoable edit.
4. **Per provider** — repeat (2) and (3) for **each** model, and confirm switching the selection in
   bundle details actually routes to the other model (assert the transcript comes from the chosen one,
   not merely that *a* transcript appeared).
5. **Isolation** — with both providers registered, confirm each has its own worker and memory, that
   reclaiming an idle model does not disturb the other, and that disabling one leaves the other usable.
6. **Negative** — bundle disabled ⇒ no mic; model absent ⇒ guidance and no download; a provider
   deregistered mid-flight ⇒ request fails cleanly; unsupported language for the selected model ⇒ an
   explicit error rather than a wrong-language transcript.

---

## 10. Remaining questions

**Q1 — Default model.** Whistle or Voz? I recommend **Whistle**: 18.4 MB and 7.6 s to first use,
versus ~390 MB and ~15 minutes for Voz. A user who needs one of Voz's other 18 languages switches in
bundle details. Registering both costs nothing, so this only sets `defaultProvider`.

**Q2 — ~~SenseVoice too?~~ Decided:** it appears in the picker as **SenseVoice (coming soon)** via a
placeholder provider that never downloads anything, with a one-config-change hand-off when it is
implemented for real (D13).

**Q3 — Remote Host.** Host-side providers only, or also a browser-side variant for setups where the
Host is a different machine from the browser? The seam defines "local" as *the Host machine*, which
can be remote.

None of these block the build: Q1 has a clear default and Q2/Q3 are additive.

---

## Appendix — reference artifacts from this research

Working code and downloaded binaries were left in `_scratch/` so implementation starts from
something known-good rather than from scratch:

| Artifact | What it is |
|---|---|
| `_scratch/whistle/koffi_test.cjs` | a **working** Node + koffi transcription against the real DLL |
| `_scratch/whistle/wasm_test.cjs` | the WASM-in-Node route, also working |
| `_scratch/whistle/needle.exe` | the engine binary (1,563,136 B) |
| `_scratch/whistle/whistle.cact` | the model (16,919,407 B) |
| `_scratch/whistle/needle.wasm` + `needle.js` | the WASM fallback pair |
| `_scratch/whistle/test16k.wav` | a 16 kHz mono PCM16 test clip |
| `E:/tmp/vozprobe/` | the Voz side: `probe-transcribe.mjs`, `download-resumable.mjs`, `speech.wav`, `REPORT.md` |

Both test clips produced correct transcripts, so they double as regression fixtures for the
verification plan in §9. `_scratch/` is disposable and should not be shipped in the bundle.

# dsh-stt

Multi-model local speech recognition for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web composer.

A microphone appears between the model selector and Send. **Click once and start talking** — the recording
ends on its own about a second after you stop speaking, and the transcript is inserted into the draft for
review. **You choose which on-device model transcribes**, and nothing is downloaded until you choose it.

<img width="769" height="108" alt="image" src="https://github.com/user-attachments/assets/a0012e0f-7193-4135-99ba-88adda783262" />

The recognizer is loaded when you *start* recording, not when you finish, so the wait happens behind your
own voice instead of after it.

## Models

| Pick | Size | Languages | Notes |
|---|---|---|---|
| **Whistle** (Cactus Compute) | **18.4 MB** | 7, auto-detected | default; loads in 30 ms, ~116 MB RAM |
| **Voz** (Desert Ant Labs) | ~390 MB | 25 | higher accuracy; ~1 GB RAM while warm |
| SenseVoice | — | — | *coming soon* — advertised only, downloads nothing |

Both working models were measured end-to-end on Windows and each transcribed a 7.62 s clip correctly:
Whistle in 1.52 s using 116 MB, Voz in 2.39 s.

## Install

This is a **rider** on the shipped voice bundle: that bundle supplies the microphone UI and the speech
service, and this package adds the models. Install both, **in this order** — layers apply in list order and
a later layer wins for a given row id:

```sh
# The voice-bundle version MATTERS: plain `add` resolves the npm `latest` tag
# (0.1.7-alpha.1), which does not match a DSH 0.2.0-rc.2 runtime. Pin yours.
dsh plugin --profile web add @deepseek-ai/dsh-experimental-voice-input-bundle@0.2.0-rc.2
dsh plugin --profile web add @try-works/dsh-stt
```

Installing from a checkout instead of the registry works the same way:
`dsh plugin --profile web add /path/to/dsh-stt`.

Then open **Settings → Plugins → Voice Input** and pick a model. The picker lists every model with its size
and time estimate; **Download and prepare** fetches only the one you selected.

## Configuration

`cordis.patch.yml` carries the whole configuration. Each model is a key under `providers`:

```yaml
providers:
  whistle-local:
    enabled: true
  voz-local:
    enabled: false        # keep 390 MB out of the picker entirely
  sensevoice-local:
    enabled: true         # placeholder only
```

| Field | Meaning |
|---|---|
| `enabled` | `false` stops the provider registering — it is never listed, selected or downloaded |
| `modelRoot` | where that model's files live; defaults to `<dataRoot>/<key>` |
| `id` | override the provider id (advanced; the selection is stored by id) |
| `name` | override the display name shown in the picker |

`dataRoot` is required and must be an absolute path.

## How the recording ends

A silence gate watches the microphone level. Nothing stops until it has heard **300 ms of speech**, so a
cough or a door cannot end a recording before you have said anything; after that, **1.2 s of quiet** ends
it. The Stop button is still there, and Escape or switching away cancels and discards.

Because this needs the microphone level, the plugin ships its own browser half and registers it into the
composer slot at a lower priority than the shipped microphone, which therefore stops rendering. That is
also why the wait disappears: the same half asks the host to load the model the moment recording starts.

## Architecture

```
src/index.js              register every enabled provider
src/config.js             schemastery configuration
src/provider-kit/
  http.js                 resumable download (see below)
  preparation.js          disk inspection + the state the UI renders
  oneshot.js              one process per recording
  worker.js               one warm process, idle-reclaimed
src/providers/whistle/    one-shot: needle.exe per recording
src/providers/voz/        warm worker holding the model
src/providers/sensevoice/ placeholder: advertises, never downloads
```

### Two deliberate engine strategies

Whistle runs **one process per recording**. Its engine loads the 16.9 MB model in ~30 ms, so paying that per
request buys real crash isolation and automatic memory reclamation. It also satisfies the engine's
*one process-global model per kind* rule for free.

Voz runs as a **warm worker** because its load costs 6.2 s and about a gigabyte; the child persists between
recordings and is released after five idle minutes.

### Why we download the models ourselves

`Voz.load()` fetches its 384,832,967 bytes with a single `fetch` per file and **no retry, no resume and no
timeout**. On a real connection that failed at 37.5% of the largest file, and a resumable retry hit three
more drops. Preparation therefore pre-populates Voz's cache with a resumable `Range` download, after which
`Voz.load({ cache: true })` adopts the files without fetching.

## Limitations

- **Insert, not send.** The transcript lands in the draft; you press Enter. No message is ever sent on your
  behalf.
- **The microphone UI is the shipped one.** This package contributes providers only, because the picker is
  keyed to the shipped voice bundle's detail page.
- **SenseVoice is advertised, not delivered.** Its entry cannot be downloaded; see the hand-over note in
  `src/providers/sensevoice/index.js`.
- **Recording limits** are the seam's defaults: 4 MB and 120 s per recording. Whistle's engine
  accepts only 30 s per call, so a longer recording is cut at the quietest nearby moment and
  transcribed in segments that are joined in order. Nothing to configure; 45 s of speech costs
  roughly 12 s of inference.
- Local means *the Host machine*, which may be remote from your browser.

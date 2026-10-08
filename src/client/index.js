// dsh-stt browser half: push-to-talk with silence detection.
//
// Plain JavaScript by necessity. DSH's client module system serves this file to the
// page as a lazy-CJS bundle, so it IS the shipped artifact: the factory receives the
// browser module table's require and returns { inject, apply }.
//
// Only 'react' is requested. Harness client packages are deliberately not imported -
// they change without notice and a throwing component blanks the slot entry - so the
// controls and styles below are written here.
//
// This registers into 'conversation.input.activity' at priority -1, shadowing the
// shipped occupant at 0. The slot renders entriesOfSlot(key)[0], lowest priority
// first, so ours renders and the shipped component stays mounted but invisible. That
// is why this file owns recording end to end: the shipped microphone cannot be asked
// to stop on silence, and it learns about a recording only after it has finished.
window.__ModuleLoader__.load({
  id: '@try-works/dsh-stt',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const h = React.createElement

    /** Rate the seam and every recognizer expect. */
    const TARGET_RATE = 16000

    /**
     * Resample mono float samples by linear interpolation.
     * @param input - mono samples in [-1, 1].
     * @param inputRate - the rate the samples were captured at.
     * @param outputRate - the wanted rate.
     * @returns the resampled samples.
     */
    function resample(input, inputRate, outputRate) {
      const wanted = outputRate === undefined ? TARGET_RATE : outputRate
      if (inputRate === wanted) return input
      const ratio = inputRate / wanted
      const length = Math.max(1, Math.floor(input.length / ratio))
      const output = new Float32Array(length)
      for (let i = 0; i < length; i += 1) {
        const at = i * ratio
        const low = Math.floor(at)
        const high = Math.min(input.length - 1, low + 1)
        const mix = at - low
        output[i] = input[low] * (1 - mix) + input[high] * mix
      }
      return output
    }

    /**
     * Wrap 16 kHz mono float samples in the canonical PCM16 WAV the seam admits.
     * @param samples - 16 kHz mono samples in [-1, 1].
     * @returns the complete file bytes.
     */
    function encodeWav(samples) {
      const bytes = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(bytes)
      const ascii = (at, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i)) }
      ascii(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      ascii(8, 'WAVE')
      ascii(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, TARGET_RATE, true)
      view.setUint32(28, TARGET_RATE * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      ascii(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      }
      return bytes
    }

    /**
     * Base64 of a byte array, built in slices so a long recording cannot blow the
     * argument limit of String.fromCharCode.
     * @param bytes - the WAV bytes.
     * @returns standard base64.
     */
    function audioBase64(bytes) {
      const view = new Uint8Array(bytes)
      let binary = ''
      const step = 0x8000
      for (let at = 0; at < view.length; at += step) {
        binary += String.fromCharCode.apply(null, view.subarray(at, at + step))
      }
      return btoa(binary)
    }

    /**
     * Reject rather than wait forever.
     *
     * Every await in the capture path crosses something that can stall without
     * ever rejecting - a MediaRecorder that never fires onstop, an AudioContext
     * that will not close - and a stalled promise here is a spinner that never
     * ends, which is worse than an error message.
     *
     * @param promise - the work to bound.
     * @param ms - the deadline in milliseconds.
     * @param what - a phrase naming the work, used in the failure.
     * @returns the promise's value.
     */
    function withDeadline(promise, ms, what) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(what + ' timed out after ' + Math.round(ms / 1000) + 's.')) }, ms)
        promise.then(
          (value) => { clearTimeout(timer); resolve(value) },
          (error) => { clearTimeout(timer); reject(error) },
        )
      })
    }

    /**
     * Decides when a recording has finished on its own.
     *
     * Push to talk, release by silence: one click starts it, and it ends `holdMs`
     * after the user stops speaking. A cough must not end it before a sentence has
     * been said, so nothing stops until `minSpeechMs` of speech is observed.
     */
    class SilenceGate {
      /** @param options - threshold, silence hold, minimum speech and the cap. */
      constructor(options) {
        const settings = options === undefined ? {} : options
        this.threshold = settings.threshold === undefined ? 0.012 : settings.threshold
        this.holdMs = settings.holdMs === undefined ? 1200 : settings.holdMs
        this.minSpeechMs = settings.minSpeechMs === undefined ? 300 : settings.minSpeechMs
        this.maxMs = settings.maxMs === undefined ? 120000 : settings.maxMs
        this.reset()
      }

      /** Forget everything observed so far. */
      reset() {
        this.startedAt = null
        this.speechMs = 0
        this.lastLoudAt = null
        this.quietSince = null
      }

      /**
       * Feed one measured frame.
       * @param amplitude - root-mean-square amplitude of the frame, in [0, 1].
       * @param at - the frame timestamp in milliseconds.
       * @returns why the recording should stop, or null to keep going.
       */
      push(amplitude, at) {
        if (this.startedAt === null) this.startedAt = at
        if (amplitude >= this.threshold) {
          if (this.lastLoudAt !== null) this.speechMs += Math.min(at - this.lastLoudAt, 100)
          this.lastLoudAt = at
          this.quietSince = null
        } else {
          if (this.lastLoudAt !== null) {
            this.speechMs += Math.min(at - this.lastLoudAt, 100)
            this.lastLoudAt = null
          }
          if (this.quietSince === null) this.quietSince = at
        }
        if (at - this.startedAt >= this.maxMs) return 'max-duration'
        if (this.speechMs >= this.minSpeechMs && this.quietSince !== null && at - this.quietSince >= this.holdMs) return 'silence'
        return null
      }
    }

    /**
     * One microphone capture: MediaRecorder for the audio, an AnalyserNode for the
     * level the silence gate reads.
     * @returns the capture handle.
     */
    function createRecording() {
      let stream = null
      let recorder = null
      let chunks = []
      let context = null
      let analyser = null
      let samples = null

      const release = async () => {
        try { if (stream !== null) for (const track of stream.getTracks()) track.stop() } catch (error) { /* tracks already ended */ }
        try { if (context !== null) await context.close() } catch (error) { /* context already closed */ }
        stream = null
        context = null
        analyser = null
        samples = null
      }

      /** Mix every channel down to one. */
      const mono = (buffer) => {
        if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)
        const mixed = new Float32Array(buffer.length)
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          const data = buffer.getChannelData(channel)
          for (let i = 0; i < data.length; i += 1) mixed[i] += data[i] / buffer.numberOfChannels
        }
        return mixed
      }

      return {
        /**
         * Open the microphone and begin capturing.
         * @param onFailure - called if the recorder itself fails mid-capture.
         * @returns after capture has begun.
         */
        async start(onFailure) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          })
          context = new (window.AudioContext || window.webkitAudioContext)()
          const source = context.createMediaStreamSource(stream)
          analyser = context.createAnalyser()
          analyser.fftSize = 2048
          samples = new Float32Array(analyser.fftSize)
          source.connect(analyser)
          chunks = []
          recorder = new MediaRecorder(stream)
          recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
          recorder.onerror = () => { onFailure(new Error('The microphone stopped responding.')) }
          recorder.start()
        },

        /**
         * Current root-mean-square amplitude, in [0, 1].
         * @returns the level of the most recent frame.
         */
        amplitude() {
          if (analyser === null || samples === null) return 0
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
          return Math.sqrt(sum / samples.length)
        },

        /**
         * Finish capturing and return a canonical 16 kHz mono PCM16 WAV.
         * @returns the complete file bytes.
         */
        async stop() {
          const recorded = recorder
          const activeContext = context
          if (recorded === null || activeContext === null) throw new Error('The microphone is no longer open.')
          const blob = await new Promise((resolve) => {
            const settle = () => { resolve(new Blob(chunks, { type: recorded.mimeType || 'audio/webm' })) }
            recorded.onstop = settle
            if (recorded.state === 'inactive') { settle(); return }
            recorded.stop()
          })
          const decoded = await activeContext.decodeAudioData(await blob.arrayBuffer())
          const wav = encodeWav(resample(mono(decoded), decoded.sampleRate))
          await release()
          return wav
        },

        /** Release the microphone and the audio context. */
        dispose: release,
      }
    }

    /**
     * Inline styles: the bundle is one file and cannot import a stylesheet.
     *
     * ACTIVE is the one accent the recording UI uses. It is deliberately green and
     * not the red a stop control usually carries: red reads as a failure state, and
     * stopping a recording is the expected, healthy thing to do. #2e9e57 is dark
     * enough that the white stop glyph on it clears 3:1.
     */
    const ACTIVE = '#2e9e57'
    const STYLE = {
      anchor: { display: 'inline-flex', alignItems: 'center' },
      // Right-aligned, so the stop control lands where the microphone was. The shipped
      // InputBar gives this slot 'flex: 1' while it is active (activityExpanded in
      // InputBar.module.css), so the row fills the width and packs its children from
      // whichever edge is set here. Anchoring to the end keeps the pointer still:
      // start and stop are the same click, in the same place.
      row: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', minWidth: 0 },
      button: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '28px', height: '28px', padding: 0, borderRadius: '14px',
        border: '1px solid #3a4048', background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      stop: { borderColor: ACTIVE, background: ACTIVE, color: '#fff' },
      mic: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '4px' },
      bar: { position: 'relative', width: '86px', height: '6px', borderRadius: '3px', background: '#2d323a', overflow: 'hidden' },
      fill: { position: 'absolute', inset: '0 auto 0 0', background: ACTIVE, borderRadius: '3px', transition: 'width 80ms linear' },
      // Shrinkable, so a long status ellipsizes instead of shouldering the stop button
      // out of position. minWidth 0 is what actually lets a flex child shrink.
      status: { flex: '0 1 auto', minWidth: 0, fontSize: '12px', opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      action: { fontSize: '12px', padding: '2px 8px', borderRadius: '6px', border: '1px solid #3a4048', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      // The activity dot. Green rather than amber, which read as a warning, and
      // rather than a fixed black, which would vanish in a dark theme: the UI
      // inherits its text colour, so a neutral dot has to be currentColor, not
      // a colour literal. It only ever shows while starting or transcribing, never
      // beside the recording controls, so it cannot be confused with the accent.
      dot: { width: '7px', height: '7px', borderRadius: '4px', background: ACTIVE, flex: '0 0 auto' },
    }

    /**
     * What the microphone will do, or why it cannot.
     *
     * A click must always answer: when nothing can start, this is the sentence the
     * user gets, because a button that silently does nothing reads as broken.
     *
     * @param catalog - the speech catalog, or null while it is still unknown.
     * @param ready - whether the selected provider can recognize right now.
     * @param trouble - the last failure reading the catalog, if any.
     * @returns the tooltip and the message a click should show.
     */
    function microphoneHint(catalog, ready, trouble) {
      if (catalog === null) {
        return trouble === '' ? 'Connecting to speech recognition\u2026' : 'Speech recognition is unavailable: ' + trouble
      }
      if (ready) return 'Dictate'
      return 'No model is ready. Choose one in Settings, then Plugins, then Voice Input.'
    }

    /** The microphone glyph, drawn here because no icon package is imported. */
    function MicrophoneIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }),
        h('path', { d: 'M5 10v2a7 7 0 0 0 14 0v-2' }),
        h('line', { x1: 12, y1: 19, x2: 12, y2: 22 }))
    }

    /**
     * The composer activity: one click starts listening, silence ends it.
     *
     * @param props - slot props plus the injected speech actions.
     * @returns the microphone, or the expanded capture row.
     */
    function VoiceActivity(props) {
      const speech = props.speech
      const inputActions = props.inputActions
      const locked = props.locked === true
      const onActiveChange = props.onActiveChange
      const [catalog, setCatalog] = React.useState(null)
      const [phase, setPhase] = React.useState('idle')
      const [message, setMessage] = React.useState('')
      const [pending, setPending] = React.useState('')
      const [level, setLevel] = React.useState(0)
      const [trouble, setTrouble] = React.useState('')
      const [elapsed, setElapsed] = React.useState(0)
      const [stage, setStage] = React.useState('')
      const active = React.useRef(null)
      const generation = React.useRef(0)
      const expanded = phase !== 'idle'

      React.useEffect(() => {
        // Polled rather than streamed: catalog() is a plain Remote call whose transport
        // the shipped half already proves, while an async-iterable subscription is one
        // more shape to get wrong. Every failure is recorded, never swallowed - a
        // silently dead microphone is indistinguishable from a broken one.
        let live = true
        const refresh = async () => {
          if (speech === undefined || typeof speech.catalog !== 'function') {
            if (live) setTrouble('the speech Remote is not available to this plugin')
            return
          }
          try {
            const result = await speech.catalog()
            if (!live) return
            if (result !== null && result !== undefined && result.ok === true) {
              setCatalog(result.value)
              setTrouble('')
              return
            }
            if (live) setTrouble(result !== null && result !== undefined && result.error !== undefined
              ? String(result.error.message)
              : 'the speech service refused the request')
          } catch (error) {
            if (!live) return
            const message = error instanceof Error ? error.message : String(error)
            setTrouble(message)
            console.warn('[dsh-stt] could not read the speech catalog:', message)
          }
        }
        void refresh()
        const timer = setInterval(() => { void refresh() }, 2000)
        return () => { live = false; clearInterval(timer) }
      }, [speech])

      const provider = catalog === null ? undefined : catalog.providers.find((item) => item.id === catalog.selection.providerId)
      const ready = provider !== undefined && (provider.preparation.phase === 'ready'
        || provider.preparation.phase === 'standby' || provider.preparation.phase === 'waking')
      const usable = catalog !== null && ready

      React.useEffect(() => { onActiveChange(expanded); return () => { onActiveChange(false) } }, [expanded, onActiveChange])

      const release = () => {
        const current = active.current
        active.current = null
        if (current !== null) {
          clearInterval(current.ticker)
          clearInterval(current.clock)
          current.abort.abort()
          void current.recording.dispose()
        }
      }

      const cancel = () => {
        generation.current += 1
        release()
        setPending(''); setMessage(''); setLevel(0); setPhase('idle'); setStage(''); setElapsed(0)
      }

      const feedback = (text) => { setMessage(text); setPhase('feedback') }

      const finish = async () => {
        const current = active.current
        if (current === null || current.phase !== 'recording') return
        current.phase = 'transcribing'
        const run = generation.current
        clearInterval(current.ticker)
        setLevel(0)
        setPhase('transcribing')
        setStage('Encoding audio\u2026')
        setElapsed(0)
        const began = Date.now()
        current.clock = setInterval(() => { setElapsed(Math.round((Date.now() - began) / 1000)) }, 250)
        try {
          const audio = await withDeadline(current.recording.stop(), 20000, 'Encoding the recording')
          if (run !== generation.current) return
          if (audio.byteLength > current.maxAudioBytes) { feedback('That recording is too long to send.'); return }
          setStage('Transcribing\u2026')
          console.info('[dsh-stt] sending ' + ((audio.byteLength - 44) / 32000).toFixed(1) + 's of audio to ' + current.selection.providerId)
          const answered = await speech.transcribe({
            audioBase64: audioBase64(audio),
            providerId: current.selection.providerId,
            language: current.selection.language,
          }, current.abort.signal)
          if (run !== generation.current) return
          // A Remote answers { ok, value } | { ok, error }; anything else is a shape we
          // do not understand and must say so rather than throw on a missing member.
          const shaped = answered !== null && answered !== undefined && typeof answered.ok === 'boolean'
          if (!shaped) {
            console.warn('[dsh-stt] unexpected transcribe response:', answered)
            feedback('Speech recognition returned an unexpected response.')
            return
          }
          if (!answered.ok) {
            const why = answered.error !== null && answered.error !== undefined && answered.error.message !== undefined
              ? String(answered.error.message)
              : 'the service refused the request'
            feedback('Speech recognition failed: ' + why)
            return
          }
          const text = answered.value !== null && answered.value !== undefined && typeof answered.value.text === 'string' ? answered.value.text : ''
          if (text === '') { feedback('No speech recognized.'); return }
          if (!inputActions.insertText(text, current.span)) {
            setPending(text)
            feedback('The draft changed while recording.')
            return
          }
          setPhase('idle')
        } catch (failure) {
          await current.recording.dispose()
          if (run === generation.current) feedback(failure instanceof Error ? failure.message : String(failure))
        } finally {
          clearInterval(current.clock)
          if (run === generation.current) active.current = null
        }
      }

      const tick = () => {
        const current = active.current
        if (current === null || current.phase !== 'recording') return
        const amplitude = current.recording.amplitude()
        setLevel(amplitude)
        if (current.gate.push(amplitude, Date.now()) !== null) void finish()
      }

      const start = async () => {
        if (catalog === null || !usable || locked || active.current !== null) return
        const run = ++generation.current
        const recording = createRecording()
        const current = {
          recording,
          abort: new AbortController(),
          span: inputActions.captureInsertion(),
          selection: catalog.selection,
          maxAudioBytes: catalog.maxAudioBytes,
          gate: new SilenceGate({ maxMs: catalog.maxDurationSeconds * 1000 }),
          phase: 'requesting',
          ticker: null,
          clock: null,
        }
        active.current = current
        setMessage(''); setPending(''); setLevel(0); setPhase('requesting'); setStage(''); setElapsed(0)
        // Load the recognizer now, while the user is still speaking, so the wait
        // happens behind the recording instead of after it.
        void speech.prepare(current.selection.providerId).catch(() => {})
        try {
          await recording.start(() => {
            if (run !== generation.current || active.current !== current || current.phase === 'transcribing') return
            release()
            feedback('The microphone stopped responding.')
          })
          if (run !== generation.current || active.current !== current) return
          current.phase = 'recording'
          setPhase('recording')
          current.ticker = setInterval(tick, 100)
        } catch (failure) {
          await recording.dispose()
          if (run === generation.current) { active.current = null; feedback(failure instanceof Error ? failure.message : String(failure)) }
        }
      }

      React.useEffect(() => {
        const blur = () => { if (active.current !== null && active.current.phase === 'recording') cancel() }
        const visibility = () => { if (document.hidden && active.current !== null && active.current.phase !== 'transcribing') cancel() }
        const escape = (event) => {
          if (event.key === 'Escape' && active.current !== null) { event.preventDefault(); cancel() }
        }
        window.addEventListener('blur', blur)
        document.addEventListener('visibilitychange', visibility)
        document.addEventListener('keydown', escape)
        return () => {
          window.removeEventListener('blur', blur)
          document.removeEventListener('visibilitychange', visibility)
          document.removeEventListener('keydown', escape)
          generation.current += 1
          release()
        }
      }, [props.sessionId])

      if (!expanded) {
        // A click must always answer. When the microphone cannot start, saying why
        // beats doing nothing: silence reads as a broken button.
        const why = microphoneHint(catalog, ready, trouble)
        return h('span', { style: STYLE.anchor },
          h('button', {
            type: 'button',
            style: STYLE.mic,
            disabled: locked,
            'aria-label': usable ? 'Start voice input' : why,
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => {
              if (usable) { void start(); return }
              feedback(why)
            },
            title: why,
          }, h(MicrophoneIcon)))
      }

      return h('div', { style: STYLE.row, 'data-stt-phase': phase },
        h('button', { type: 'button', style: STYLE.button, 'aria-label': 'Cancel', onClick: cancel }, '\u00d7'),
        phase === 'recording'
          ? h(React.Fragment, null,
            h('span', { style: STYLE.bar }, h('span', { style: { ...STYLE.fill, width: Math.min(100, Math.round(level * 400)) + '%' } })),
            h('span', { style: STYLE.status }, 'Listening\u2026'),
            h('button', { type: 'button', style: { ...STYLE.button, ...STYLE.stop }, 'aria-label': 'Stop and transcribe', onClick: () => { void finish() } }, '\u25a0'))
          : h(React.Fragment, null,
            (phase === 'requesting' || phase === 'transcribing') ? h('span', { style: STYLE.dot }) : null,
            h('span', { style: STYLE.status, role: 'status', title: pending || message },
              phase === 'feedback' ? message
                : phase === 'requesting' ? 'Starting\u2026'
                  : (stage === '' ? 'Transcribing\u2026' : stage) + (elapsed > 2 ? ' ' + elapsed + 's' : '')),
            phase === 'feedback' && pending
              ? h('button', { type: 'button', style: STYLE.action, onClick: () => {
                if (inputActions.insertText(pending, inputActions.captureInsertion())) { setPending(''); setPhase('idle') }
              } }, 'Insert')
              : null,
            phase === 'feedback' && !pending
              ? h('button', { type: 'button', style: STYLE.action, disabled: !usable || locked, onClick: () => { void start() } }, 'Retry')
              : null))
    }

    /**
     * Services this half waits for.
     *
     * 'remote' MUST be named alongside 'remote.speech': Cordis gates every property
     * access on the inject face, so reading ctx.remote to reach the nested speech
     * namespace throws `cannot get property "remote" without inject` unless the
     * parent service is declared too. Naming both also makes Cordis wait until the
     * generated speech Remote the shipped voice bundle mounts actually exists.
     */
    const inject = ['slots', 'remote', 'remote.speech']

    /**
     * Register the composer activity, shadowing the shipped microphone.
     * @param ctx - the browser plugin context.
     * @returns nothing.
     */
    function apply(ctx) {
      const actions = {
        transcribe: async (request, signal) => await ctx.remote.speech.transcribe(request, signal),
        prepare: async (providerId) => { await ctx.remote.speech.prepare(providerId) },
        catalog: async () => await ctx.remote.speech.catalog(),
      }
      ctx.effect(() => ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
        name: 'conversation.input.activity',
        // Lower than the shipped occupant at 0: the slot renders the lowest priority.
        priority: -1,
        inject: () => ({ speech: actions }),
      }, VoiceActivity)))
    }

    // Both installed precedents set this; Cordis uses it to name the fiber's logger.
    exports.name = 'dsh-stt'
    exports.apply = apply
    exports.inject = inject
    /**
     * Pure helpers, exported only so the test suite can reach them: this file is the
     * shipped bundle, so it cannot be imported piecemeal. Cordis ignores members it
     * does not know.
     */
    exports.internals = { SilenceGate, VoiceActivity, audioBase64, encodeWav, microphoneHint, resample, withDeadline }
    return module.exports
  },
})

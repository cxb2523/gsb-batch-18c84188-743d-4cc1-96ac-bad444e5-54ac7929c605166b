import { DSPNode } from '../core/dsp-node.js';

export class PitchShiftNodeUI extends DSPNode {
    constructor(x, y, app) {
        super(x, y, 'Pitch Shifter', app);
        this.type = 'pitch-shifter';
        this.width = 200;

        // Base (user / preset) values and the last values actually applied.
        // Effective values track modulation so automation never overwrites the
        // values that get saved into snapshots and presets.
        this.semitones = 0;
        this.effectiveSemitones = 0;
        this.cents = 0;
        this.effectiveCents = 0;
        this.mix = 1;
        this.effectiveMix = 1;
        this.pitchRatio = 1;

        this.context = null;
        this.inputGain = null;
        this.outputGain = null;
        this.dryDelay = null;
        this.dryGain = null;
        this.wetGain = null;
        this.bypassGain = null;
        this.workletNode = null;
        this.deferredInit = false;
        // Estimated compensation latency (samples) used until the worklet
        // reports the real value measured inside the processing thread.
        this.latencySamples = 0;
        // False until a latency report from the *current* worklet arrives, so
        // stale messages from an old context can never poison a new node.
        this.latencyConfirmed = false;
        this._bypassCleanupTimer = null;

        this.fftSize = PitchShiftNodeUI.defaultFFTSize;
        this.overlap = PitchShiftNodeUI.defaultOverlap;
    }

    initAudio(ctx) {
        // Re-initialisation must start from a clean slate: any latency, gain
        // or worklet state left over from a previous context cannot survive.
        this.context = ctx;
        this.workletNode = null;
        this.deferredInit = false;
        this.latencyConfirmed = false;
        if (this._bypassCleanupTimer) {
            clearTimeout(this._bypassCleanupTimer);
            this._bypassCleanupTimer = null;
        }

        this.inputGain = ctx.createGain();
        this.outputGain = ctx.createGain();
        this.dryDelay = ctx.createDelay(1.0);
        this.dryGain = ctx.createGain();
        this.wetGain = ctx.createGain();
        this.bypassGain = ctx.createGain();
        this.bypassGain.gain.value = 1;

        this.inputGain.connect(this.dryDelay);
        this.dryDelay.connect(this.dryGain);
        this.dryGain.connect(this.outputGain);

        this.inputGain.connect(this.bypassGain);
        this.bypassGain.connect(this.wetGain);
        this.wetGain.connect(this.outputGain);

        this.inputs = [{ name: 'In', id: 0, node: this.inputGain }];
        this.outputs = [{ name: 'Out', id: 0, node: this.outputGain }];

        this.params = [
            {
                label: 'Semitones',
                type: 'range',
                value: this.semitones,
                min: -24,
                max: 24,
                scale: 'linear',
                onChange: (v, meta) => this.setSemitones(v, ctx, meta)
            },
            {
                label: 'Fine (cents)',
                type: 'range',
                value: this.cents,
                min: -100,
                max: 100,
                scale: 'linear',
                onChange: (v, meta) => this.setFine(v, ctx, meta)
            },
            {
                label: 'Mix',
                type: 'range',
                value: this.mix,
                min: 0,
                max: 1,
                scale: 'linear',
                onChange: (v, meta) => this.setMix(v, ctx, meta)
            }
        ];

        this.initializeParams();
        this.computeHeight();

        // Fallback estimate until the worklet reports the measured latency.
        this.latencySamples = this.estimateLatency(this.fftSize, this.overlap);
        this.latencyConfirmed = false;
        this.updateDryDelay(ctx);
        this.updateMix(ctx);

        this.prepareWorklet(ctx);
    }

    // Keep these in lock-step with the worklet's sanitisers so the fallback
    // estimate agrees with the latency the processing thread will measure.
    static sanitizeFFTSize(size) {
        let value = 512;
        while (value < size) {
            value <<= 1;
        }
        if (value > 8192) value = 8192;
        return value;
    }

    static sanitizeOverlap(overlap, fftSize) {
        let value = Math.max(2, Math.floor(overlap));
        if (value > fftSize) value = fftSize;
        while (fftSize % value !== 0 && value > 2) {
            value--;
        }
        if (fftSize % value !== 0) {
            value = 2;
        }
        return value;
    }

    estimateLatency(fftSize, overlap) {
        const size = PitchShiftNodeUI.sanitizeFFTSize(fftSize);
        const slices = PitchShiftNodeUI.sanitizeOverlap(overlap, size);
        const hop = Math.max(1, Math.floor(size / slices));
        return Math.max(0, size - hop);
    }

    static _isAutomation(meta) {
        return !!(meta && meta.fromAutomation === true);
    }

    setSemitones(value, ctx, meta) {
        const next = Number.isFinite(value)
            ? Math.max(-24, Math.min(24, value))
            : this.semitones;
        this.effectiveSemitones = next;
        if (!PitchShiftNodeUI._isAutomation(meta)) {
            // User / preset edit: persist into the value used for snapshots.
            this.semitones = next;
            const param = this.params && this.params[0];
            if (param) {
                param.value = next;
                param.effectiveValue = next;
            }
        } else {
            const param = this.params && this.params[0];
            if (param) param.effectiveValue = next;
        }
        this.updatePitchParam(ctx);
    }

    setFine(value, ctx, meta) {
        const next = Number.isFinite(value)
            ? Math.max(-100, Math.min(100, value))
            : this.cents;
        this.effectiveCents = next;
        if (!PitchShiftNodeUI._isAutomation(meta)) {
            this.cents = next;
            const param = this.params && this.params[1];
            if (param) {
                param.value = next;
                param.effectiveValue = next;
            }
        } else {
            const param = this.params && this.params[1];
            if (param) param.effectiveValue = next;
        }
        this.updatePitchParam(ctx);
    }

    setMix(value, ctx, meta) {
        const next = Math.max(0, Math.min(1, Number.isFinite(value) ? value : this.mix));
        this.effectiveMix = next;
        if (!PitchShiftNodeUI._isAutomation(meta)) {
            this.mix = next;
            const param = this.params && this.params[2];
            if (param) {
                param.value = next;
                param.effectiveValue = next;
            }
        } else {
            const param = this.params && this.params[2];
            if (param) param.effectiveValue = next;
        }
        this.updateMix(ctx);
    }

    updateMix(ctx) {
        if (!this.dryGain || !this.wetGain) return;
        const context = ctx || this.context;
        // Complementary gains: dry + wet is exactly 1 at every instant.
        const wet = this.effectiveMix;
        const dry = 1 - wet;
        if (context) {
            const now = context.currentTime;
            this.dryGain.gain.setTargetAtTime(dry, now, 0.02);
            this.wetGain.gain.setTargetAtTime(wet, now, 0.02);
        } else {
            this.dryGain.gain.value = dry;
            this.wetGain.gain.value = wet;
        }
    }

    computePitchRatio() {
        // Drive the ratio from the modulated (effective) values, but always
        // clamp it into the same 0.25–4 range enforced inside the worklet.
        const total = this.effectiveSemitones + (this.effectiveCents / 100);
        const ratio = Math.pow(2, total / 12);
        return Math.min(4, Math.max(0.25, ratio));
    }

    updatePitchParam(ctx) {
        this.pitchRatio = this.computePitchRatio();
        const context = ctx || this.context;
        if (this.workletNode) {
            const param = this.workletNode.parameters.get('ratio');
            if (param) {
                if (context) {
                    // setTargetAtTime ramps the change instead of jumping; the
                    // worklet smooths per-block as a second line of defence.
                    param.setTargetAtTime(this.pitchRatio, context.currentTime, 0.01);
                } else {
                    param.value = this.pitchRatio;
                }
            }
        }
    }

    updateDryDelay(ctx) {
        if (!this.dryDelay) return;
        const context = ctx || this.context;
        if (!context) return;
        // Latency comes from the worklet once reported; before then the
        // estimated fallback is used so the path is never silent/uncompensated.
        const seconds = Math.min(0.9, Math.max(0, this.latencySamples / context.sampleRate));
        this.dryDelay.delayTime.setTargetAtTime(seconds, context.currentTime, 0.02);
    }

    // Apply a new frame configuration at runtime. The worklet re-measures its
    // latency after reconfiguring and posts it back; until that arrives the
    // refreshed estimate keeps the dry path aligned.
    reconfigureWorklet(fftSize, overlap) {
        if (typeof fftSize === 'number' && Number.isFinite(fftSize)) {
            this.fftSize = fftSize;
        }
        if (typeof overlap === 'number' && Number.isFinite(overlap)) {
            this.overlap = overlap;
        }
        this.latencyConfirmed = false;
        this.latencySamples = this.estimateLatency(this.fftSize, this.overlap);
        this.updateDryDelay();
        if (this.workletNode) {
            this.sendConfiguration();
        }
    }

    prepareWorklet(ctx) {
        if (!PitchShiftNodeUI.shouldUseWorklet(ctx)) {
            console.warn('Pitch shifter worklet unavailable; wet signal will remain bypassed.');
            return;
        }

        const attachIfReady = () => {
            if (this.audioCtxActive(ctx) && !this.workletNode) {
                this.attachWorklet(ctx);
            }
        };

        if (PitchShiftNodeUI.isWorkletReady(ctx)) {
            attachIfReady();
            return;
        }

        this.deferredInit = true;
        PitchShiftNodeUI.ensureWorklet(ctx)
            .then(() => {
                this.deferredInit = false;
                attachIfReady();
            })
            .catch((err) => {
                this.deferredInit = false;
                PitchShiftNodeUI.markUnsupported(ctx);
                console.error('Pitch shifter worklet load failed', err);
            });
    }

    audioCtxActive(ctx) {
        return !!this.context && this.context === ctx;
    }

    attachWorklet(ctx) {
        try {
            this.workletNode = new AudioWorkletNode(ctx, 'hq-pitch-shifter', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                channelCount: 2,
                channelCountMode: 'explicit',
                channelInterpretation: 'speakers',
                parameterData: { ratio: this.pitchRatio },
                processorOptions: {
                    fftSize: this.fftSize,
                    overlap: this.overlap
                }
            });
        } catch (err) {
            console.error('Pitch shifter worklet initialisation failed', err);
            this.workletNode = null;
            return;
        }

        // A fresh worklet means any earlier confirmation is stale; fall back
        // to the estimate until this worklet's first latency report arrives.
        this.latencyConfirmed = false;
        this.latencySamples = this.estimateLatency(this.fftSize, this.overlap);
        this.updateDryDelay(ctx);

        const workletNode = this.workletNode;
        this.inputGain.connect(this.workletNode);
        this.workletNode.connect(this.wetGain);

        if (this.bypassGain) {
            const fadeEnd = ctx.currentTime + 0.05;
            this.bypassGain.gain.setValueAtTime(this.bypassGain.gain.value, ctx.currentTime);
            this.bypassGain.gain.linearRampToValueAtTime(0, fadeEnd);
            if (this._bypassCleanupTimer) {
                clearTimeout(this._bypassCleanupTimer);
            }
            this._bypassCleanupTimer = setTimeout(() => {
                if (!this.audioCtxActive(ctx) || !this.bypassGain) return;
                try { this.inputGain.disconnect(this.bypassGain); } catch (e) { }
                try { this.bypassGain.disconnect(); } catch (e) { }
                this.bypassGain = null;
            }, 80);
        }

        this.updatePitchParam(ctx);
        this.sendConfiguration();

        this.workletNode.port.onmessage = (event) => {
            // Ignore reports from a worklet/context this node no longer owns.
            if (this.workletNode !== workletNode || !this.context || this.context !== ctx) return;
            this.handleWorkletMessage(event.data);
        };
    }

    sendConfiguration() {
        if (!this.workletNode) return;
        this.workletNode.port.postMessage({
            type: 'configure',
            fftSize: this.fftSize,
            overlap: this.overlap
        });
    }

    handleWorkletMessage(data) {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'latency') {
            const samples = Number(data.samples);
            // The worker thread's measured latency is authoritative once it
            // reports; guard against malformed or stale payloads.
            if (Number.isFinite(samples) && samples >= 0 && this.context && this.dryDelay) {
                this.latencySamples = samples;
                this.latencyConfirmed = true;
                this.updateDryDelay();
            }
        }
    }

    onRemoved() {
        if (this._bypassCleanupTimer) {
            clearTimeout(this._bypassCleanupTimer);
            this._bypassCleanupTimer = null;
        }

        this.deferredInit = false;

        if (this.workletNode) {
            try { this.workletNode.port.postMessage({ type: 'reset' }); } catch (e) { }
            try { this.workletNode.port.onmessage = null; } catch (e) { }
            try { this.workletNode.disconnect(); } catch (e) { }
        }
        this.workletNode = null;

        if (this.bypassGain) {
            try { this.bypassGain.disconnect(); } catch (e) { }
            this.bypassGain = null;
        }

        if (this.inputGain) {
            try { this.inputGain.disconnect(); } catch (e) { }
        }
        if (this.dryDelay) {
            try { this.dryDelay.disconnect(); } catch (e) { }
        }
        if (this.dryGain) {
            try { this.dryGain.disconnect(); } catch (e) { }
        }
        if (this.wetGain) {
            try { this.wetGain.disconnect(); } catch (e) { }
        }
        if (this.outputGain) {
            try { this.outputGain.disconnect(); } catch (e) { }
        }

        this.inputGain = null;
        this.outputGain = null;
        this.dryDelay = null;
        this.dryGain = null;
        this.wetGain = null;
        this.context = null;

        // Drop every piece of derived state so a later re-add / new context
        // re-initialises from the estimate instead of stale latency/gains.
        this.latencySamples = 0;
        this.latencyConfirmed = false;
        this.pitchRatio = 1;
        this.effectiveSemitones = this.semitones;
        this.effectiveCents = this.cents;
        this.effectiveMix = this.mix;
    }
}

PitchShiftNodeUI.defaultFFTSize = 2048;
PitchShiftNodeUI.defaultOverlap = 4;
PitchShiftNodeUI.workletModulePath = 'js/worklets/hq-pitch-shifter.js';

PitchShiftNodeUI.shouldUseWorklet = function (ctx) {
    if (!ctx) return false;
    if (PitchShiftNodeUI.isWorkletUnsupported(ctx)) return false;
    if (!ctx.audioWorklet) return false;
    if (typeof AudioWorkletNode === 'undefined') return false;
    if (typeof window !== 'undefined') {
        const protocol = window.location && window.location.protocol ? window.location.protocol.toLowerCase() : '';
        if (protocol && protocol !== 'http:' && protocol !== 'https:') return false;
        if (typeof window.isSecureContext !== 'undefined' && window.isSecureContext === false) return false;
    }
    return true;
};

PitchShiftNodeUI.markUnsupported = function (ctx) {
    if (!ctx) return;
    if (!PitchShiftNodeUI._workletStates) {
        PitchShiftNodeUI._workletStates = new WeakMap();
    }
    PitchShiftNodeUI._workletStates.set(ctx, { ready: false, unsupported: true });
};

PitchShiftNodeUI.ensureWorklet = function (ctx) {
    if (!ctx) return Promise.resolve();

    if (!PitchShiftNodeUI._workletStates) {
        PitchShiftNodeUI._workletStates = new WeakMap();
    }

    const state = PitchShiftNodeUI._workletStates.get(ctx);
    if (state && state.ready) {
        return Promise.resolve();
    }
    if (state && state.promise) {
        return state.promise;
    }

    if (!PitchShiftNodeUI.shouldUseWorklet(ctx)) {
        PitchShiftNodeUI.markUnsupported(ctx);
        return Promise.resolve();
    }

    const modulePath = PitchShiftNodeUI.workletModulePath;
    if (!modulePath) {
        PitchShiftNodeUI.markUnsupported(ctx);
        return Promise.resolve();
    }

    const promise = ctx.audioWorklet.addModule(modulePath)
        .then(() => {
            PitchShiftNodeUI._workletStates.set(ctx, { ready: true });
        })
        .catch((err) => {
            PitchShiftNodeUI.markUnsupported(ctx);
            throw err;
        });

    PitchShiftNodeUI._workletStates.set(ctx, { ready: false, promise });
    return promise;
};

PitchShiftNodeUI.isWorkletReady = function (ctx) {
    if (!ctx || !PitchShiftNodeUI._workletStates) return false;
    const state = PitchShiftNodeUI._workletStates.get(ctx);
    return !!(state && state.ready);
};

PitchShiftNodeUI.isWorkletUnsupported = function (ctx) {
    if (!ctx || !PitchShiftNodeUI._workletStates) return false;
    const state = PitchShiftNodeUI._workletStates.get(ctx);
    return !!(state && state.unsupported);
};

import { AudioX } from 'audio';
import { bands, presets } from 'constants/equalizer';
import { isValidArray } from 'helpers/common';

import type { EqualizerStatus, Preset } from 'types/equalizer.types';

/**
 * Registry of MediaElementSourceNodes that have already been created.
 *
 * A media element can only be wrapped in a single MediaElementSourceNode per
 * AudioContext: calling `createMediaElementSource` twice with the same element
 * throws an InvalidStateError. The registry guarantees the source node for any
 * given audio element is created exactly once and then reused.
 */
const mediaElementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

class Equalizer {
  private static _instance: Equalizer | undefined;
  private audioCtx: AudioContext;
  private audioCtxStatus: EqualizerStatus = 'IDEAL';
  private eqFilterBands: BiquadFilterNode[] = [];
  private bassBoostFilter: BiquadFilterNode | undefined;
  private compressor: DynamicsCompressorNode | undefined;
  private audioSource: MediaElementAudioSourceNode | undefined;
  private boundAudioElement: HTMLMediaElement | undefined;
  /**
   * Whether this instance itself created the registered source node. Only the
   * owner may remove the registry entry during teardown; an instance that
   * reused an existing source must leave it in place.
   */
  private ownsAudioSource = false;

  /**
   * Most recent equalizer configuration. It is cached so that it can be
   * re-applied once a suspended AudioContext is resumed after a user gesture,
   * and after a failed initialization is retried successfully.
   */
  private lastPresetId: keyof Preset | undefined;
  private lastCustomGains: number[] | undefined;
  private lastBassBoost: { enabled: boolean; gain: number } = { enabled: false, gain: 0 };
  private resumeHandler: (() => void) | undefined;
  private stateChangeHandler: (() => void) | undefined;

  /**
   * Creates an instance of Equalizer or returns the existing instance.
   *
   * The singleton is only published once the processing chain has been built
   * successfully. A failure tears the partial instance down again instead of
   * caching it, so a later `play()` can retry from a clean state.
   */
  constructor() {
    if (Equalizer._instance) {
      console.warn(
        'Instantiation failed: cannot create multiple instances of Equalizer. Returning existing instance.',
      );
      // biome-ignore lint/correctness/noConstructorReturn: singleton must return the existing instance
      return Equalizer._instance;
    }

    this.initializeAudioContext();
    // Reaching this point means the chain was built; publish the singleton.
    Equalizer._instance = this;
  }

  /**
   * Tears down every node created during a failed initialization attempt so
   * that no half-initialized Equalizer is left behind and a retry starts from
   * scratch. A source node this attempt created (and only that one) is removed
   * from the shared media-element registry because its context is closed.
   * @private
   */
  private teardown() {
    for (const node of this.eqFilterBands ?? []) {
      try {
        node.disconnect();
      } catch (_error) {
        /* node may already be disconnected */
      }
    }
    for (const node of [this.bassBoostFilter, this.compressor, this.audioSource]) {
      if (node) {
        try {
          node.disconnect();
        } catch (_error) {
          /* node may already be disconnected */
        }
      }
    }
    // A source created by this failed attempt belongs to a context that is
    // about to be closed. Remove it from the registry so a retry creates a
    // fresh source in the new context instead of connecting across contexts.
    if (this.ownsAudioSource && this.boundAudioElement) {
      mediaElementSources.delete(this.boundAudioElement);
    }
    this.eqFilterBands = [];
    this.bassBoostFilter = undefined;
    this.compressor = undefined;
    this.audioSource = undefined;
    this.boundAudioElement = undefined;
    this.ownsAudioSource = false;

    if (this.resumeHandler && typeof document !== 'undefined' && document.body) {
      document.body.removeEventListener('click', this.resumeHandler, false);
      document.body.removeEventListener('pointerdown', this.resumeHandler, false);
      document.body.removeEventListener('keydown', this.resumeHandler, false);
    }
    this.resumeHandler = undefined;
    if (this.stateChangeHandler && this.audioCtx) {
      this.audioCtx.removeEventListener('statechange', this.stateChangeHandler);
    }
    this.stateChangeHandler = undefined;

    if (this.audioCtx) {
      try {
        void this.audioCtx.close();
      } catch (_error) {
        /* context may already be closed */
      }
    }
  }

  /**
   * Initializes the AudioContext, ensuring compatibility with older browsers.
   * Throws when the Web Audio API is unavailable or the processing chain
   * cannot be built, allowing callers to retry later.
   * @private
   */
  private initializeAudioContext() {
    const audioContextOptions = { latencyHint: 'playback' };
    if (typeof AudioContext !== 'undefined') {
      this.audioCtx = new AudioContext(audioContextOptions as AudioContextOptions);
    } else if (
      typeof window !== 'undefined' &&
      typeof (window as any).webkitAudioContext !== 'undefined'
    ) {
      this.audioCtx = new (window as any).webkitAudioContext(audioContextOptions);
    } else {
      this.audioCtxStatus = 'FAILED';
      throw new Error('Web Audio API is not supported in this browser.');
    }

    try {
      this.init();
    } catch (error) {
      // Do not leave a half-initialized instance behind.
      this.audioCtxStatus = 'FAILED';
      this.teardown();
      throw error instanceof Error ? error : new Error('Equalizer initialization failed');
    }

    if (this.audioCtx.state === 'suspended') {
      this.addResumeListener();
    }
  }

  /**
   * Adds listeners that resume the AudioContext after the first user
   * interaction. Browsers start the context suspended until a gesture happens.
   * @private
   */
  private addResumeListener() {
    if (typeof document === 'undefined' || !document.body || this.resumeHandler) {
      return;
    }

    this.resumeHandler = () => {
      if (!this.audioCtx || this.audioCtx.state !== 'suspended') {
        return;
      }
      void this.audioCtx.resume().then(() => {
        if (this.audioCtx.state === 'running' && this.resumeHandler) {
          document.body.removeEventListener('click', this.resumeHandler, false);
          document.body.removeEventListener('pointerdown', this.resumeHandler, false);
          document.body.removeEventListener('keydown', this.resumeHandler, false);
          this.resumeHandler = undefined;
        }
      });
    };

    document.body.addEventListener('click', this.resumeHandler, false);
    document.body.addEventListener('pointerdown', this.resumeHandler, false);
    document.body.addEventListener('keydown', this.resumeHandler, false);
  }

  /**
   * Re-applies the last preset, custom gains and bass boost configuration.
   * Parameter changes scheduled on a suspended context do not become audible
   * until the context is running, so replaying the cached values on resume
   * makes every setting take effect.
   * @private
   */
  private reapplySettings() {
    if (this.audioCtxStatus !== 'ACTIVE') {
      return;
    }
    if (this.lastPresetId !== undefined) {
      this.applyPreset(this.lastPresetId);
    } else if (isValidArray(this.lastCustomGains ?? [])) {
      this.applyCustomEQ(this.lastCustomGains as number[]);
    }
    this.applyBassBoost(this.lastBassBoost.enabled, this.lastBassBoost.gain);
  }

  /**
   * Initializes the equalizer by setting up the audio source and filter bands.
   * The MediaElementSourceNode for an audio element is created at most once;
   * a retry reuses the existing source and only rebuilds the processing nodes.
   */
  init() {
    const audioInstance = AudioX.getAudioInstance();
    if (!audioInstance) {
      throw new Error('Equalizer initialization failed: audio element is not available.');
    }

    // The chain for this audio element already exists: keep using it instead
    // of creating a second source node (which browsers reject).
    if (this.boundAudioElement === audioInstance && this.audioCtxStatus === 'ACTIVE') {
      return;
    }

    let audioSource = mediaElementSources.get(audioInstance);
    if (!audioSource) {
      audioSource = this.audioCtx.createMediaElementSource(audioInstance);
      mediaElementSources.set(audioInstance, audioSource);
      this.ownsAudioSource = true;
    }
    this.audioSource = audioSource;
    this.boundAudioElement = audioInstance;

    const equalizerBands = bands.map((band) => {
      const filter = this.audioCtx.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.frequency;
      filter.gain.value = band.gain;
      filter.Q.value = band.q || 1; // Use a default Q of 1 if not specified
      return filter;
    });

    // Create a compressor for overall dynamic control
    const compressor = this.audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 30;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    // Create the bass boost filter
    const bassBoostFilter = this.audioCtx.createBiquadFilter();
    bassBoostFilter.type = 'lowshelf';
    bassBoostFilter.frequency.value = 100;
    bassBoostFilter.gain.value = 0;

    // Connect the nodes
    audioSource.connect(equalizerBands[0]);
    for (let i = 0; i < equalizerBands.length - 1; i++) {
      equalizerBands[i].connect(equalizerBands[i + 1]);
    }
    equalizerBands[equalizerBands.length - 1].connect(bassBoostFilter);
    bassBoostFilter.connect(compressor);
    compressor.connect(this.audioCtx.destination);

    this.compressor = compressor;
    this.bassBoostFilter = bassBoostFilter;
    this.eqFilterBands = equalizerBands;
    this.audioCtxStatus = 'ACTIVE';

    // Replay any configuration requested before the chain was ready, and keep
    // applying it whenever a suspended context transitions back to running.
    this.stateChangeHandler = () => {
      if (this.audioCtx.state === 'running') {
        this.reapplySettings();
      }
    };
    this.audioCtx.addEventListener('statechange', this.stateChangeHandler);
    this.reapplySettings();
  }

  /**
   * Internal preset application without readiness bookkeeping.
   * @private
   */
  private applyPreset(id: keyof Preset) {
    const preset = presets.find((el) => el.id === id);
    if (!preset) {
      return;
    }
    const currentTime = this.audioCtx.currentTime;
    for (let index = 0; index < this.eqFilterBands.length; index++) {
      this.eqFilterBands[index].gain.setTargetAtTime(preset.gains[index], currentTime, 0.05);
    }
  }

  /**
   * Sets the equalizer to a predefined preset.
   * @param {keyof Preset} id - The ID of the preset to apply.
   */
  setPreset(id: keyof Preset) {
    const preset = presets.find((el) => el.id === id);
    if (!preset) {
      console.error('Preset not found:', id);
      return;
    }

    if (this.audioCtxStatus !== 'ACTIVE' || !isValidArray(this.eqFilterBands)) {
      console.error('Equalizer is not ready, preset will not be applied.');
      return;
    }

    if (this.eqFilterBands.length !== preset.gains.length) {
      console.error('Invalid data provided.');
      return;
    }

    this.lastPresetId = id;
    // A preset overrides any previous custom gain configuration.
    this.lastCustomGains = undefined;
    this.applyPreset(id);
  }

  /**
   * Retrieves the list of available presets.
   * @returns {Preset[]} The list of available presets.
   */
  static getPresets() {
    return presets;
  }

  /**
   * Gets the current status of the AudioContext.
   * @returns {EqualizerStatus} The current status of the AudioContext.
   */
  status() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume();
    }
    return this.audioCtxStatus;
  }

  /**
   * Internal custom gain application without readiness bookkeeping.
   * @private
   */
  private applyCustomEQ(gains: number[]) {
    const currentTime = this.audioCtx.currentTime;
    for (let index = 0; index < this.eqFilterBands.length; index++) {
      this.eqFilterBands[index].gain.setTargetAtTime(gains[index], currentTime, 0.05);
    }
  }

  /**
   * Sets a custom equalizer configuration.
   * @param {number[]} gains - The gain values for each band.
   */
  setCustomEQ(gains: number[]) {
    if (this.audioCtxStatus !== 'ACTIVE' || !isValidArray(this.eqFilterBands)) {
      console.error('Equalizer is not ready, custom EQ will not be applied.');
      return;
    }
    if (isValidArray(gains) && gains.length === this.eqFilterBands.length) {
      this.lastCustomGains = gains.slice();
      // Custom gains override any previous preset.
      this.lastPresetId = undefined;
      this.applyCustomEQ(gains);
    } else {
      console.error('Invalid array of gains provided.');
    }
  }

  /**
   * Internal bass boost application without readiness bookkeeping.
   * @private
   */
  private applyBassBoost(enable: boolean, gain: number) {
    if (!this.bassBoostFilter) {
      return;
    }
    const targetGain = enable ? gain : 0;
    this.bassBoostFilter.gain.setTargetAtTime(targetGain, this.audioCtx.currentTime, 0.05);
  }

  /**
   * Enables or disables bass boost.
   * @param {boolean} enable - Whether to enable or disable bass boost.
   * @param {number} gain - The gain value for bass boost.
   */
  setBassBoost(enable: boolean, gain = 6) {
    if (this.audioCtxStatus !== 'ACTIVE' || !this.bassBoostFilter) {
      console.error('Equalizer is not ready, bass boost will not be applied.');
      return;
    }
    this.lastBassBoost = { enabled: enable, gain };
    this.applyBassBoost(enable, gain);
  }

  /**
   * Adjusts the compressor settings.
   * @param {Partial<DynamicsCompressorOptions>} options - The compressor options to adjust.
   */
  setCompressorSettings(options: Partial<DynamicsCompressorOptions>) {
    if (this.compressor) {
      if (options.threshold !== undefined)
        this.compressor.threshold.setTargetAtTime(
          options.threshold,
          this.audioCtx.currentTime,
          0.01,
        );
      if (options.knee !== undefined)
        this.compressor.knee.setTargetAtTime(options.knee, this.audioCtx.currentTime, 0.01);
      if (options.ratio !== undefined)
        this.compressor.ratio.setTargetAtTime(options.ratio, this.audioCtx.currentTime, 0.01);
      if (options.attack !== undefined)
        this.compressor.attack.setTargetAtTime(options.attack, this.audioCtx.currentTime, 0.01);
      if (options.release !== undefined)
        this.compressor.release.setTargetAtTime(options.release, this.audioCtx.currentTime, 0.01);
    }
  }

  /**
   * Resets the equalizer to flat response.
   */
  reset() {
    if (this.audioCtxStatus !== 'ACTIVE' || !isValidArray(this.eqFilterBands)) {
      return;
    }
    const currentTime = this.audioCtx.currentTime;
    for (const band of this.eqFilterBands) {
      band.gain.setTargetAtTime(0, currentTime, 0.05);
    }
    this.bassBoostFilter?.gain.setTargetAtTime(0, currentTime, 0.05);
    this.lastPresetId = undefined;
    this.lastCustomGains = undefined;
    this.lastBassBoost = { enabled: false, gain: 0 };
  }
}

export { Equalizer, mediaElementSources };

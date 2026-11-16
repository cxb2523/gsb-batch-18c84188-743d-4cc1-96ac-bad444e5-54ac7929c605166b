import type { Preset } from 'types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAudioContext, type MockAudioElement, installWebAudioMocks } from './webAudioMock';

// The public API types preset ids as `keyof Preset` (the preset shape) rather
// than the preset id union, so string ids are cast at the call sites.
const presetId = (id: string): keyof Preset => id as keyof Preset;

/**
 * Every test gets fresh module singletons (AudioX/Equalizer hold module-level
 * state) and fresh Web Audio globals.
 */
async function loadFreshModules() {
  vi.resetModules();
  MockAudioContext.reset();
  const [{ AudioX }, { Equalizer, mediaElementSources }] = await Promise.all([
    import('audio'),
    import('adapters/equalizer'),
  ]);
  return { AudioX, Equalizer, mediaElementSources };
}

function makeTrack(id: string) {
  return {
    id,
    title: `track-${id}`,
    source: `https://example.com/${id}.mp3`,
    artwork: null,
  };
}

describe('AudioX equalizer processing chain', () => {
  let uninstallMocks: () => void;

  beforeEach(() => {
    uninstallMocks = installWebAudioMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    uninstallMocks();
    vi.restoreAllMocks();
  });

  it('builds the source node and processing chain only once across repeated play() calls', async () => {
    const { AudioX } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: true });

    const audioElement = AudioX.getAudioInstance() as unknown as MockAudioElement;
    audioElement.src = 'https://example.com/first.mp3';

    await player.play();
    expect(MockAudioContext.totalMediaElementSourceCount).toBe(1);
    expect((player as any).eqStatus).toBe('ACTIVE');

    // Repeated play calls must not attach the element a second time.
    await player.play();
    await player.play();
    expect(MockAudioContext.totalMediaElementSourceCount).toBe(1);

    // The full graph exists exactly once: 10 EQ bands + bass shelf + compressor.
    const ctx = MockAudioContext.createdContexts[0];
    expect(ctx.createdNodes.biquad).toHaveLength(11);
    expect(ctx.createdNodes.compressor).toHaveLength(1);

    // Source -> first band -> ... -> last band -> bass -> compressor -> destination
    const source = ctx.createdNodes.mediaElementSource[0];
    expect(source.connections).toHaveLength(1);
    const firstBand = source.connections[0];
    expect(ctx.createdNodes.biquad).toContain(firstBand);
    const compressor = ctx.createdNodes.compressor[0];
    expect(compressor.connections).toContain(ctx.destination);
  });

  it('keeps the established chain working across track changes (addMedia)', async () => {
    const { AudioX } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: true });

    const audioElement = AudioX.getAudioInstance() as unknown as MockAudioElement;
    audioElement.src = 'https://example.com/first.mp3';

    await player.play();
    expect(MockAudioContext.totalMediaElementSourceCount).toBe(1);

    // Switch tracks: addMedia only swaps the src, it must not rebuild the chain.
    await player.addMedia(makeTrack('second'));
    await player.play();
    await player.addMedia(makeTrack('third'));
    await player.play();

    expect(MockAudioContext.totalMediaElementSourceCount).toBe(1);
    expect(audioElement.src).toBe('https://example.com/third.mp3');
    expect(audioElement.loadCalls).toBeGreaterThan(0);

    // A preset applied after the track switch must drive the existing bands.
    player.setPreset(presetId('rock'));
    const ctx = MockAudioContext.createdContexts[0];
    const eqBands = ctx.createdNodes.biquad.slice(0, 10);
    const rockGains = [4.8, 2.88, -3.36, -4.8, -1.92, 2.4, 5.28, 6.72, 6.72, 6.72];
    eqBands.forEach((band, index) => {
      expect(band.gain.value).toBeCloseTo(rockGains[index], 5);
    });
  });

  it('does not leave a half-initialized instance after failure and retries on the next play', async () => {
    const { AudioX, Equalizer } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: true });

    const audioElement = AudioX.getAudioInstance() as unknown as MockAudioElement;
    audioElement.src = 'https://example.com/first.mp3';

    // First attempt fails while building the chain.
    MockAudioContext.failCreateMediaElementSourceOnce = true;
    await player.play();

    expect((player as any).eqStatus).toBe('FAILED');
    expect((player as any).eqInstance).toBeUndefined();
    // The failed Equalizer must not have been cached as the singleton.
    expect((Equalizer as any)._instance).toBeUndefined();
    // Its context was closed during teardown.
    const failedCtx = MockAudioContext.createdContexts[0];
    expect(failedCtx.closed).toBe(true);

    // A subsequent play retries and succeeds.
    await player.play();
    expect((player as any).eqStatus).toBe('ACTIVE');
    expect((player as any).eqInstance).toBeDefined();
    expect((Equalizer as any)._instance).toBeDefined();
    // Only the successful attempt created a source node; the failed one threw first.
    expect(MockAudioContext.totalMediaElementSourceCount).toBe(1);

    // Repeated plays after recovery still do not rebuild anything.
    await player.play();
    expect(MockAudioContext.totalMediaElementSourceCount).toBe(1);
  });

  it('retries successfully even when several plays fail before the context becomes usable', async () => {
    const { AudioX } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: true });
    const audioElement = AudioX.getAudioInstance() as unknown as MockAudioElement;
    audioElement.src = 'https://example.com/first.mp3';

    MockAudioContext.failCreateMediaElementSourceOnce = true;
    await player.play();
    await player.play(); // still FAILED state, retries again and now succeeds
    expect((player as any).eqStatus).toBe('ACTIVE');
    expect(MockAudioContext.totalMediaElementSourceCount).toBe(1);
  });

  it('cleans up the source registry when wiring fails after source creation, then retries cleanly', async () => {
    const { AudioX, mediaElementSources } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: true });
    const audioElement = AudioX.getAudioInstance() as unknown as MockAudioElement;
    audioElement.src = 'https://example.com/first.mp3';

    // The source node is created first, then filter construction fails.
    MockAudioContext.failCreateBiquadFilterOnce = true;
    await player.play();
    expect((player as any).eqStatus).toBe('FAILED');

    // No stale source may remain registered for the element, otherwise a
    // retry would connect it to nodes owned by a different (closed) context.
    expect(mediaElementSources.get(audioElement as unknown as HTMLMediaElement)).toBeUndefined();
    expect(MockAudioContext.createdContexts[0].closed).toBe(true);

    // Retry creates a fresh source in a fresh context and fully succeeds.
    await player.play();
    expect((player as any).eqStatus).toBe('ACTIVE');
    expect(MockAudioContext.createdContexts).toHaveLength(2);
    expect(MockAudioContext.totalMediaElementSourceCount).toBe(2);
    const retryCtx = MockAudioContext.createdContexts[1];
    expect(retryCtx.createdNodes.biquad).toHaveLength(11);
    expect(mediaElementSources.get(audioElement as unknown as HTMLMediaElement)).toBe(
      retryCtx.createdNodes.mediaElementSource[0],
    );
  });

  it('applies settings requested during a FAILED state once the retry succeeds', async () => {
    const { AudioX } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: true });
    const audioElement = AudioX.getAudioInstance() as unknown as MockAudioElement;
    audioElement.src = 'https://example.com/first.mp3';

    MockAudioContext.failCreateMediaElementSourceOnce = true;
    await player.play();
    expect((player as any).eqStatus).toBe('FAILED');

    // While failed, settings are queued instead of being dropped or throwing.
    player.setPreset(presetId('dance'));
    player.setBassBoost(true, 7);
    expect((player as any).pendingEqOperations).toHaveLength(2);

    await player.play(); // retry succeeds
    expect((player as any).eqStatus).toBe('ACTIVE');
    expect((player as any).pendingEqOperations).toHaveLength(0);

    const ctx = MockAudioContext.createdContexts[MockAudioContext.createdContexts.length - 1];
    const eqBands = ctx.createdNodes.biquad.slice(0, 10);
    const danceGains = [5.76, 4.32, 1.44, 0, 0, -3.36, -4.32, -4.32, 0, 0];
    eqBands.forEach((band, index) => {
      expect(band.gain.value).toBeCloseTo(danceGains[index], 5);
    });
    expect(ctx.createdNodes.biquad[10].gain.value).toBeCloseTo(7, 5);
  });

  it('re-applies preset, custom gains and bass boost after a suspended context resumes following a user gesture', async () => {
    const { AudioX } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: true });
    const audioElement = AudioX.getAudioInstance() as unknown as MockAudioElement;
    audioElement.src = 'https://example.com/first.mp3';

    // Contexts now start suspended, as browsers do before the first gesture.
    MockAudioContext.gestureRequired = true;

    await player.play();
    const ctx = MockAudioContext.createdContexts[0];
    expect(ctx.state).toBe('suspended');
    expect((player as any).eqStatus).toBe('ACTIVE');
    expect(ctx.resumeCallCount).toBeGreaterThan(0);

    // Configure everything while suspended.
    player.setPreset(presetId('pop'));
    player.setBassBoost(true, 8);
    const eqBands = ctx.createdNodes.biquad.slice(0, 10);
    const bassShelf = ctx.createdNodes.biquad[10];
    const popGains = [0.96, 2.88, 4.32, 4.8, 3.36, 0, -1.44, -1.44, 0.96, 0.96];
    eqBands.forEach((band, index) => {
      expect(band.gain.value).toBeCloseTo(popGains[index], 5);
    });
    expect(bassShelf.gain.value).toBeCloseTo(8, 5);

    // Snapshot the scheduled automation before the gesture unblocks resume.
    const automationBeforeGesture = eqBands.map((band) => band.gain.automation.length);
    const bassAutomationBeforeGesture = bassShelf.gain.automation.length;

    // Simulate the user interaction the Equalizer registered listeners for.
    const resumeCallsBeforeGesture = ctx.resumeCallCount;
    document.body.dispatchEvent(new Event('click'));
    ctx.simulateGestureResume();
    expect(ctx.state).toBe('running');
    expect(ctx.resumeCallCount).toBeGreaterThan(resumeCallsBeforeGesture);

    // The statechange handler replays preset + bass boost so they become
    // audible now that the context is running.
    eqBands.forEach((band, index) => {
      expect(band.gain.value).toBeCloseTo(popGains[index], 5);
      expect(band.gain.automation.length).toBeGreaterThan(automationBeforeGesture[index]);
    });
    expect(bassShelf.gain.value).toBeCloseTo(8, 5);
    expect(bassShelf.gain.automation.length).toBeGreaterThan(bassAutomationBeforeGesture);

    // Custom EQ overrides the preset and is also replayed on a later resume.
    const customGains = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    player.setCustomEQ(customGains);
    ctx.forceSuspended();
    ctx.simulateStateChangeRunning();
    eqBands.forEach((band, index) => {
      expect(band.gain.value).toBeCloseTo(customGains[index], 5);
    });

    // After the gesture unblocked it, the document-level listener was removed.
    expect((player as any).eqInstance).toBeDefined();
  });

  it('queues preset changes requested before the first successful play and applies them once ready', async () => {
    const { AudioX } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: true });
    const audioElement = AudioX.getAudioInstance() as unknown as MockAudioElement;
    audioElement.src = 'https://example.com/first.mp3';

    // EQ not attached yet: operations are queued instead of throwing.
    player.setPreset(presetId('club'));
    player.setBassBoost(true, 5);
    expect((player as any).pendingEqOperations).toHaveLength(2);

    await player.play();
    expect((player as any).pendingEqOperations).toHaveLength(0);

    const ctx = MockAudioContext.createdContexts[0];
    const eqBands = ctx.createdNodes.biquad.slice(0, 10);
    const clubGains = [0, 0, 4.8, 3.36, 3.36, 3.36, 1.92, 0, 0, 0];
    eqBands.forEach((band, index) => {
      expect(band.gain.value).toBeCloseTo(clubGains[index], 5);
    });
    expect(ctx.createdNodes.biquad[10].gain.value).toBeCloseTo(5, 5);
  });

  it('preserves the existing error behavior when the equalizer was not enabled', async () => {
    const { AudioX } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: false });

    player.setPreset(presetId('rock'));
    player.setCustomEQ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    player.setBassBoost(true, 6);

    expect(console.error).toHaveBeenCalledTimes(3);
    for (const call of (console.error as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toContain('Equalizer not initialized');
    }
    // No audio context was ever created.
    expect(MockAudioContext.createdContexts).toHaveLength(0);
  });

  it('never creates more than one MediaElementSource per audio element even across separate Equalizer builds', async () => {
    const { AudioX, Equalizer, mediaElementSources } = await loadFreshModules();
    const player = new AudioX();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true, enableEQ: true });
    const audioElement = AudioX.getAudioInstance() as unknown as MockAudioElement;
    audioElement.src = 'https://example.com/first.mp3';

    await player.play();
    const registeredSource = mediaElementSources.get(audioElement as unknown as HTMLMediaElement);
    expect(registeredSource).toBeDefined();

    // Simulate a fresh Equalizer being asked to init against the same element
    // (the per-element registry must hand back the existing source node).
    const singleton = (Equalizer as any)._instance;
    (Equalizer as any)._instance = undefined;
    const rebuilt = new Equalizer();
    expect(rebuilt).not.toBe(singleton);
    expect(MockAudioContext.totalMediaElementSourceCount).toBe(1);
  });
});

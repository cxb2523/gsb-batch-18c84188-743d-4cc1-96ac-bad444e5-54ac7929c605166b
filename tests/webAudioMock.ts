/**
 * Controllable, in-memory implementation of the Web Audio API plus a mock
 * HTMLAudioElement. No real audio is produced and no browser is required, so
 * the equalizer graph can be asserted deterministically (node counts,
 * connections, suspended/resumed context state, failure injection).
 */

type AnyRecord = Record<string, any>;

class MockAudioParam {
  value: number;
  readonly automation: Array<{ type: string; value: number; time: number; constant: number }> = [];

  constructor(value = 0) {
    this.value = value;
  }

  private record(type: string, value: number, time: number, constant = 0.05) {
    this.automation.push({ type, value, time, constant });
    // Scheduled automation converges toward the target value immediately in
    // the mock so assertions can read the intended end state.
    this.value = value;
  }

  setTargetAtTime(value: number, time: number, constant: number) {
    this.record('setTargetAtTime', value, time, constant);
  }

  setValueAtTime(value: number, time: number) {
    this.record('setValueAtTime', value, time);
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.record('linearRampToValueAtTime', value, time);
  }
}

class MockAudioNode {
  readonly connections: MockAudioNode[] = [];
  disconnected = false;

  connect(destination: MockAudioNode): MockAudioNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnected = true;
    this.connections.length = 0;
  }
}

class MockBiquadFilterNode extends MockAudioNode {
  type: BiquadFilterType = 'peaking';
  frequency = new MockAudioParam();
  gain = new MockAudioParam();
  Q = new MockAudioParam(1);
}

class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(-24);
  knee = new MockAudioParam(30);
  ratio = new MockAudioParam(12);
  attack = new MockAudioParam(0.003);
  release = new MockAudioParam(0.25);
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam(1);
}

class MockMediaElementAudioSourceNode extends MockAudioNode {
  readonly mediaElement: MockAudioElement;
  readonly owningContext: MockAudioContext;

  constructor(mediaElement: MockAudioElement, owningContext: MockAudioContext) {
    super();
    this.mediaElement = mediaElement;
    this.owningContext = owningContext;
  }
}

export class MockAudioContext {
  static readonly createdContexts: MockAudioContext[] = [];
  static failCreateMediaElementSourceOnce = false;
  /**
   * When true, the very next createBiquadFilter() call throws, emulating a
   * failure that happens AFTER the media element source was created.
   */
  static failCreateBiquadFilterOnce = false;
  /**
   * When true, resume() stays pending until simulateGestureResume() is called,
   * mirroring browsers that block autoplay until a user interaction.
   */
  static gestureRequired = false;

  readonly latencyHint?: string;
  state: 'suspended' | 'running' | 'closed' = 'running';
  readonly currentTime = 0;
  readonly destination = new MockAudioNode();
  private stateListeners = new Set<() => void>();
  readonly createdNodes = {
    biquad: [] as MockBiquadFilterNode[],
    compressor: [] as MockDynamicsCompressorNode[],
    gain: [] as MockGainNode[],
    mediaElementSource: [] as MockMediaElementAudioSourceNode[],
  };
  private resumeCalls = 0;
  private pendingResumeResolvers: Array<() => void> = [];
  closed = false;

  constructor(options?: AudioContextOptions) {
    this.latencyHint = options?.latencyHint as string | undefined;
    // Autoplay policy: the context is born suspended until a gesture.
    if (MockAudioContext.gestureRequired) {
      this.state = 'suspended';
    }
    MockAudioContext.createdContexts.push(this);
  }

  createBiquadFilter(): MockBiquadFilterNode {
    if (MockAudioContext.failCreateBiquadFilterOnce) {
      MockAudioContext.failCreateBiquadFilterOnce = false;
      throw new DOMException('Injected createBiquadFilter failure', 'InvalidStateError');
    }
    const node = new MockBiquadFilterNode();
    this.createdNodes.biquad.push(node);
    return node;
  }

  createDynamicsCompressor(): MockDynamicsCompressorNode {
    const node = new MockDynamicsCompressorNode();
    this.createdNodes.compressor.push(node);
    return node;
  }

  createGain(): MockGainNode {
    const node = new MockGainNode();
    this.createdNodes.gain.push(node);
    return node;
  }

  createMediaElementSource(element: MockAudioElement): MockMediaElementAudioSourceNode {
    // Mirrors Chrome: an HTMLMediaElement can only be wrapped once while the
    // owning context is alive. A closed context releases the element so a
    // fresh context can re-wrap it on retry.
    if (element.sourceNode && element.sourceNode.owningContext.state !== 'closed') {
      throw new DOMException(
        "Failed to execute 'createMediaElementSource': HTMLMediaElement already connected previously to a different MediaElementSourceNode.",
        'InvalidStateError',
      );
    }
    if (MockAudioContext.failCreateMediaElementSourceOnce) {
      MockAudioContext.failCreateMediaElementSourceOnce = false;
      throw new DOMException('Injected createMediaElementSource failure', 'InvalidStateError');
    }
    const node = new MockMediaElementAudioSourceNode(element, this);
    element.sourceNode = node;
    this.createdNodes.mediaElementSource.push(node);
    return node;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.state === 'closed') {
      return Promise.resolve();
    }
    if (this.state === 'running') {
      return Promise.resolve();
    }
    // Autoplay-policy style: stay suspended until a simulated user gesture.
    if (MockAudioContext.gestureRequired) {
      return new Promise<void>((resolve) => {
        this.pendingResumeResolvers.push(resolve);
      });
    }
    this.transitionToRunning();
    return Promise.resolve();
  }

  private transitionToRunning(): void {
    this.state = 'running';
    const listeners = [...this.stateListeners];
    for (const listener of listeners) {
      listener();
    }
    const resolvers = this.pendingResumeResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  /** Test helper: emulate the user gesture that unblocks a pending resume(). */
  simulateGestureResume(): void {
    if (this.state === 'suspended') {
      this.transitionToRunning();
    }
  }

  get resumeCallCount(): number {
    return this.resumeCalls;
  }

  suspend(): Promise<void> {
    if (this.state !== 'closed') {
      this.state = 'suspended';
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    this.closed = true;
    return Promise.resolve();
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') {
      this.stateListeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') {
      this.stateListeners.delete(listener);
    }
  }

  /** Test helper: flip back to suspended without going through resume(). */
  forceSuspended(): void {
    this.state = 'suspended';
  }

  /** Test helper: emit a statechange to running without touching resume(). */
  simulateStateChangeRunning(): void {
    this.state = 'running';
    const listeners = [...this.stateListeners];
    for (const listener of listeners) {
      listener();
    }
  }

  /** Number of source nodes ever created across every mock context. */
  static get totalMediaElementSourceCount(): number {
    return MockAudioContext.createdContexts.reduce(
      (count, ctx) => count + ctx.createdNodes.mediaElementSource.length,
      0,
    );
  }

  static reset(): void {
    MockAudioContext.createdContexts.length = 0;
    MockAudioContext.failCreateMediaElementSourceOnce = false;
    MockAudioContext.failCreateBiquadFilterOnce = false;
    MockAudioContext.gestureRequired = false;
  }
}

export class MockAudioElement {
  src = '';
  paused = true;
  muted = false;
  volume = 1;
  playbackRate = 1;
  currentTime = 0;
  loop = false;
  preload = '';
  autoplay = false;
  crossOrigin: string | null = null;
  sourceNode: MockMediaElementAudioSourceNode | undefined;
  readonly HAVE_ENOUGH_DATA = 4;
  readonly buffered = { length: 0, start: () => 0, end: () => 0 };
  readonly played = { length: 0, start: () => 0, end: () => 0 };
  error: { code: number } | null = null;
  private attributes: AnyRecord = {};
  private listeners: Record<string, Set<(event?: any) => void>> = {};
  loadCalls = 0;
  playShouldReject = false;

  setAttribute(name: string, value: any): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): any {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  addEventListener(type: string, callback: (event?: any) => void): void {
    if (!this.listeners[type]) {
      this.listeners[type] = new Set();
    }
    this.listeners[type].add(callback);
  }

  removeEventListener(type: string, callback: (event?: any) => void): void {
    this.listeners[type]?.delete(callback);
  }

  dispatchEvent(event: { type: string }): boolean {
    const callbacks = this.listeners[event.type];
    if (callbacks) {
      for (const callback of callbacks) {
        callback(event);
      }
    }
    return true;
  }

  canPlayType(): string {
    return '';
  }

  async play(): Promise<void> {
    if (this.playShouldReject) {
      throw new DOMException('The play() request was interrupted', 'AbortError');
    }
    this.paused = false;
    this.dispatchEvent({ type: 'play' });
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    this.loadCalls += 1;
  }
}

/**
 * Installs the global mocks the library modules expect at import time.
 * Returns a cleanup function that restores the previous globals.
 */
export function installWebAudioMocks(): () => void {
  const originals: AnyRecord = {
    AudioContext: (globalThis as AnyRecord).AudioContext,
    webkitAudioContext: (globalThis as AnyRecord).webkitAudioContext,
    Audio: (globalThis as AnyRecord).Audio,
  };

  (globalThis as AnyRecord).AudioContext = MockAudioContext;
  (globalThis as AnyRecord).webkitAudioContext = undefined;
  (globalThis as AnyRecord).Audio = MockAudioElement;

  // jsdom has no MediaMetadata / mediaSession; provide inert stand-ins so the
  // media-session handler does not throw during init.
  if (typeof (globalThis as AnyRecord).MediaMetadata === 'undefined') {
    (globalThis as AnyRecord).MediaMetadata = class MediaMetadata {
      constructor(public props: AnyRecord) {}
    };
  }
  const navigatorRef = globalThis as AnyRecord;
  const previousMediaSession = navigatorRef.navigator?.mediaSession;
  if (navigatorRef.navigator && !navigatorRef.navigator.mediaSession) {
    navigatorRef.navigator.mediaSession = {
      metadata: undefined,
      setActionHandler(): void {},
      setPositionState(): void {},
    };
  }

  return () => {
    (globalThis as AnyRecord).AudioContext = originals.AudioContext;
    (globalThis as AnyRecord).webkitAudioContext = originals.webkitAudioContext;
    (globalThis as AnyRecord).Audio = originals.Audio;
    if (navigatorRef.navigator) {
      navigatorRef.navigator.mediaSession = previousMediaSession;
    }
  };
}

const xhrMockClass = () => ({
  open            : jest.fn(),
  send            : jest.fn(),
  setRequestHeader: jest.fn(),
  abort           : jest.fn(),
});
XMLHttpRequest = jest.fn().mockImplementation(xhrMockClass);

// every HTML5 Audio instance created by the player, so tests can drive
// loadedmetadata / canplaythrough and inspect volume-related state
const audioInstances = [];
const audioMockClass = () => {
  const listeners = {};
  const audio = {
    addEventListener: jest.fn((name, callback) => {
      listeners[name] = callback;
    }),
    fire            : (name) => {
      if (listeners[name]) {
        listeners[name]();
      }
    },
    load            : jest.fn(),
    pause           : jest.fn(),
    play            : jest.fn(() => Promise.resolve(jest.fn())),
    duration        : 0,
    currentTime     : 0,
    seekable        : { length: 0 },
    src             : '',
  };
  audioInstances.push(audio);
  return audio;
};
Audio = jest.fn().mockImplementation(audioMockClass);

const audioContextMockClass = () => ({
  createGain: () => ({
    gain: { value: 1 },
    connect: jest.fn(),
  }),
});

window = {
  clearTimeout     : jest.fn(),
  setTimeout       : jest.fn(),
  AudioContext     : jest.fn().mockImplementation(audioContextMockClass),
};

const { Gapless5, LogLevel, CrossfadeShape } = require('./gapless5.js');

/** test data **/

const TRACKS = [ '0.mp3', '1.mp3', '2.mp3', '3.mp3', '4.mp3' ];
const INIT_OPTIONS = {
  logLevel: LogLevel.None,
  useWebAudio: false,
  useHTML5Audio: false,
};
const TRACK_DURATION_SEC = 100;

/** helpers **/

const findAudio = (audioPath) => audioInstances.find((audio) => audio.src === audioPath);

// Creates a player whose first track is fully "loaded" over HTML5 Audio, so the
// source knows its length and can be driven through fades without playback.
const createLoadedSource = (options = {}) => {
  const player = new Gapless5({
    ...INIT_OPTIONS,
    useHTML5Audio: true,
    tracks: TRACKS,
    ...options,
  });
  const source = player.playlist.sources[0];
  const audio = findAudio(TRACKS[0]);
  audio.duration = TRACK_DURATION_SEC;
  audio.fire('loadedmetadata');
  audio.fire('canplaythrough');
  return { player: player, source: source, audio: audio };
};

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

/** test suite **/

describe('Gapless-5 object', () => {
  let player = null;

  beforeEach(() => {
    player = new Gapless5(INIT_OPTIONS);
  });

  it('has correct initial state', () => {
    expect(player.getTracks()).toStrictEqual([]);
    expect(player.totalTracks()).toBe(0);
    expect(player.getIndex()).toBe(-1);
    expect(player.getPosition()).toBe(0);
    expect(player.canShuffle()).toBe(false);
    expect(player.initialized).toBe(true);
    expect(player.hasGUI).toBe(false);
  });

  it('can manipulate tracklist and position', () => {
    player.addTrack(TRACKS[1]);
    expect(player.getIndex()).toBe(0);
    player.insertTrack(0, TRACKS[0]);
    expect(player.getTracks()).toStrictEqual([ TRACKS[0], TRACKS[1] ]);
    expect(player.findTrack(TRACKS[1])).toBe(1);
    player.setPlaybackRate(0.1);
    player.setPosition(10);
    expect(player.getPosition()).toBe(10);

    player.removeTrack(0);
    expect(player.getTracks()).toStrictEqual([ TRACKS[1] ]);
    player.removeAllTracks();
    expect(player.getTracks()).toStrictEqual([]);
    player.setPosition(10);
    expect(player.getPosition()).toBe(0); // setPosition should do nothing without a track
  });
});

describe('Gapless-5 object with tracklist', () => {
  let player = null;

  beforeEach(() => {
    player = new Gapless5({
      ...INIT_OPTIONS,
      tracks: TRACKS,
    });
  });

  it('has correct initial state', () => {
    expect(player.getTracks()).toStrictEqual(TRACKS);
    expect(player.getIndex()).toBe(0);
    expect(player.getPosition()).toBe(0);
    expect(player.initialized).toBe(true);
    expect(player.hasGUI).toBe(false);
  });

  it('can shuffle and un-shuffle tracklist', () => {
    expect(player.canShuffle()).toBe(true);
    expect(player.isShuffled()).toBe(false);
    player.shuffle();
    expect(player.isShuffled()).toBe(true);

    // shouldn't actually shuffle until we change tracks
    expect(player.getTracks()).toStrictEqual(TRACKS);
    player.next();
    expect(player.getTracks()).not.toStrictEqual(TRACKS);
    expect(player.totalTracks()).toBe(TRACKS.length);

    // shouldn't actually unshuffle until we change tracks
    player.toggleShuffle();
    expect(player.isShuffled()).toBe(false);
    expect(player.getTracks()).not.toStrictEqual(TRACKS);
    player.next();
    expect(player.getTracks()).toStrictEqual(TRACKS);
  });

  it('can navigate the tracklist', () => {
    expect(player.getIndex()).toBe(0);
    player.next();
    expect(player.getIndex()).toBe(1);
    player.prev();
    expect(player.getIndex()).toBe(0);
    player.gotoTrack(2);
    expect(player.getIndex()).toBe(2);

    // should loop around
    player.loop = true;
    TRACKS.forEach(() => player.next());
    expect(player.getIndex()).toBe(2);

    // should not loop around
    player.loop = false;
    TRACKS.forEach(() => player.next());
    expect(player.getIndex()).toBe(TRACKS.length - 1);
  });

  it('triggers navigation callbacks', () => {
    player.onprev = jest.fn();
    player.onnext = jest.fn();
    player.onplayrequest = jest.fn();
    player.onpause = jest.fn();
    player.onstop = jest.fn();

    player.next();
    expect(player.onnext).toHaveBeenCalledWith(TRACKS[0], TRACKS[1]);
    player.prev();
    expect(player.onprev).toHaveBeenCalledWith(TRACKS[1], TRACKS[0]);
    player.play();
    expect(player.onplayrequest).toHaveBeenCalledWith(TRACKS[0]);
    player.pause();
    expect(player.onpause).toHaveBeenCalledWith(TRACKS[0]);
    player.stop();
    expect(player.onstop).toHaveBeenCalledWith(TRACKS[0]);
  });

  it('regression: maintains correct index when removing tracks that come after the currently playing track', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    // Verify initial state
    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual(testTracks);

    // Move to track 1
    testPlayer.gotoTrack(1);
    expect(testPlayer.getIndex()).toBe(1);

    // Remove track at index 2
    testPlayer.removeTrack(2);

    // Check index is still 1 and track list is updated
    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track2.mp3' ]);
  });

  it('regression: maintains correct index when removing the currently playing track', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    // Verify initial state
    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual(testTracks);

    // Move to track 1
    testPlayer.gotoTrack(1);
    expect(testPlayer.getIndex()).toBe(1);
    testPlayer.play();

    // Remove the currently playing track
    testPlayer.removeTrack(1);

    // Check index is still 1 and track list is updated, therefore we move to the next available track
    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track3.mp3' ]);

    testPlayer.play();

    // Remove the currently playing track
    testPlayer.removeTrack(1);

    // Check index is still 0 and track list is updated, therefore we move to the next available track
    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3' ]);

    testPlayer.play();

    // Remove the only remaining track — list is empty, index resets to -1
    testPlayer.removeTrack(0);
    expect(testPlayer.getIndex()).toBe(-1);
    expect(testPlayer.getTracks()).toStrictEqual([]);
  });

  it('regression: removing a track does not wipe shuffledIndices', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    testPlayer.shuffle();
    testPlayer.next(); // commit the shuffle
    expect(testPlayer.isShuffled()).toBe(true);
    expect(testPlayer.playlist.shuffledIndices.length).toBe(testTracks.length);

    testPlayer.removeTrack(0);

    // Shuffle order should still be intact (one fewer entry, still shuffled)
    expect(testPlayer.isShuffled()).toBe(true);
    expect(testPlayer.playlist.shuffledIndices.length).toBe(testTracks.length - 1);
    expect(testPlayer.getTracks().length).toBe(testTracks.length - 1);
  });

  it('regression: removing currently-playing track repeatedly until empty does not crash', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    // Walk the list down to zero by always removing the current track
    // This reproduces a crash in the pre-PR code where updateLoading()
    // would dereference an undefined source after the list went empty.
    while (testPlayer.getTracks().length > 0) {
      testPlayer.removeTrack(testPlayer.getIndex());
    }
    expect(testPlayer.getTracks()).toStrictEqual([]);
    expect(testPlayer.getIndex()).toBe(-1);
  });

  it('regression: removing current-at-tail with loop=true wraps to start and resumes', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
      loop: true,
    });

    testPlayer.gotoTrack(2);
    expect(testPlayer.getIndex()).toBe(2);

    // Force the tail source to report as playing so removeTrack takes the
    // wasPlaying branch (the mock audio env never transitions real state).
    testPlayer.playlist.sources[2].inPlayState = () => true;

    testPlayer.onnext = jest.fn();
    testPlayer.onplayrequest = jest.fn();

    testPlayer.removeTrack(2);

    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track2.mp3' ]);
    expect(testPlayer.onnext).toHaveBeenCalledWith('track3.mp3', 'track1.mp3');
    expect(testPlayer.onplayrequest).toHaveBeenCalledTimes(1);
    expect(testPlayer.onplayrequest).toHaveBeenCalledWith('track1.mp3');
  });

  it('regression: removing current-at-tail with loop=false clamps and always pauses', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
      loop: false,
    });

    testPlayer.gotoTrack(2);
    expect(testPlayer.getIndex()).toBe(2);

    // Force the tail source to report as playing so removeTrack takes the
    // wasPlaying branch — this is the scenario where the old code would
    // have auto-resumed on the clamped-to-last track.
    testPlayer.playlist.sources[2].inPlayState = () => true;

    testPlayer.onnext = jest.fn();
    testPlayer.onplayrequest = jest.fn();

    testPlayer.removeTrack(2);

    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track2.mp3' ]);
    expect(testPlayer.onnext).toHaveBeenCalledWith('track3.mp3', 'track2.mp3');
    expect(testPlayer.onplayrequest).not.toHaveBeenCalled();
  });

  it('regression: removing a track does not spuriously disable shuffle when never shuffled', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    expect(testPlayer.isShuffled()).toBe(false);
    const setShuffleSpy = jest.spyOn(testPlayer.playlist, 'setShuffle');

    // Drop to 2 tracks — previously tripped the shuffle-disable path
    // because `this.isShuffled` (a function reference) was always truthy.
    testPlayer.removeTrack(0);

    expect(testPlayer.isShuffled()).toBe(false);
    expect(setShuffleSpy).not.toHaveBeenCalled();
    setShuffleSpy.mockRestore();
  });
});

describe('Gapless-5 object with load limit', () => {
  it('obeys load limit', () => {
    const player = new Gapless5({
      ...INIT_OPTIONS,
      loadLimit: 2,
    });
    const loadedTracks = new Set([]);
    player.onloadstart = (audioPath) => {
      loadedTracks.add(audioPath);
    };
    player.onunload = (audioPath) => {
      loadedTracks.delete(audioPath);
    };

    TRACKS.forEach((track) => player.addTrack(track));
    expect(player.totalTracks()).toBe(TRACKS.length);
    expect(loadedTracks.size).toBe(2);
    player.next();
    expect(loadedTracks.size).toBe(2);
    player.next();
    expect(loadedTracks.size).toBe(2);
    player.removeAllTracks();
    expect(loadedTracks.size).toBe(0);
  });
});

describe('Gapless-5 crossfade timing vs playbackRate', () => {
  // Keep the math readable: with CrossfadeShape.Linear the gain is simply
  // how far the playhead has moved through the fade window.
  const CROSSFADE_MS = 5000;
  const DURATION_MS = TRACK_DURATION_SEC * 1000;

  // Starts the first track so the source is in Play state (needed for the
  // ended-callback scheduling) without waiting on any real timers.
  const playAndSettle = async(source) => {
    source.play();
    await flushPromises();
    expect(source.inPlayState(true)).toBe(true);
  };

  // Delay (ms) passed to the most recent window.setTimeout call.
  const lastTimeoutDelay = () => {
    const calls = window.setTimeout.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][1];
  };

  let player = null;
  let source = null;

  beforeEach(() => {
    audioInstances.length = 0;
    window.setTimeout.mockClear();
    window.clearTimeout.mockClear();
    ({ player, source } = createLoadedSource({ crossfade: CROSSFADE_MS }));
    source.setCrossfade(CROSSFADE_MS, CROSSFADE_MS);
    player.setCrossfadeShape(CrossfadeShape.Linear);
    expect(source.getLength()).toBe(DURATION_MS);
  });

  it('fades out over exactly crossfade ms of real time at 1.0x', () => {
    player.setPlaybackRate(1);

    // Fade-out starts exactly crossfade ms before the end of the track.
    source.setPosition(DURATION_MS - CROSSFADE_MS, false);
    expect(source.getVolume()).toBeCloseTo(1, 5);

    // Halfway through the real fade window.
    source.setPosition(DURATION_MS - (CROSSFADE_MS / 2), false);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);

    // One ms of track position is one ms of real time at 1.0x.
    source.setPosition(DURATION_MS - (CROSSFADE_MS / 4), false);
    expect(source.getVolume()).toBeCloseTo(0.25, 5);

    // Silent at the very end.
    source.setPosition(DURATION_MS, false);
    expect(source.getVolume()).toBeCloseTo(0, 5);
  });

  it('fades out over exactly crossfade ms of real time at 2.0x', () => {
    player.setPlaybackRate(2);

    // At 2x, crossfade real ms cover twice as much track position.
    source.setPosition(DURATION_MS - (CROSSFADE_MS * 2), false);
    expect(source.getVolume()).toBeCloseTo(1, 5);

    // Halfway through the window in real time == halfway in track position.
    source.setPosition(DURATION_MS - CROSSFADE_MS, false);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);

    source.setPosition(DURATION_MS - (CROSSFADE_MS / 2), false);
    expect(source.getVolume()).toBeCloseTo(0.25, 5);

    source.setPosition(DURATION_MS, false);
    expect(source.getVolume()).toBeCloseTo(0, 5);

    // The fade must NOT start early (which the old position*rate math did).
    source.setPosition(DURATION_MS - (CROSSFADE_MS * 3), false);
    expect(source.getVolume()).toBeCloseTo(1, 5);
  });

  it('fades in over exactly crossfade ms of real time at 1.0x', () => {
    player.setPlaybackRate(1);

    source.setPosition(CROSSFADE_MS, false);
    expect(source.getVolume()).toBeCloseTo(1, 5);

    source.setPosition(CROSSFADE_MS / 2, false);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);

    source.setPosition(CROSSFADE_MS / 4, false);
    expect(source.getVolume()).toBeCloseTo(0.25, 5);

    source.setPosition(0, false);
    expect(source.getVolume()).toBeCloseTo(0, 5);
  });

  it('fades in over exactly crossfade ms of real time at 2.0x', () => {
    player.setPlaybackRate(2);

    // Fade-in window covers 2x the track position at 2x.
    source.setPosition(CROSSFADE_MS * 2, false);
    expect(source.getVolume()).toBeCloseTo(1, 5);

    source.setPosition(CROSSFADE_MS, false);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);

    source.setPosition(CROSSFADE_MS / 2, false);
    expect(source.getVolume()).toBeCloseTo(0.25, 5);

    // The fade-in must not run longer than crossfade real ms.
    source.setPosition((CROSSFADE_MS * 2) + 1, false);
    expect(source.getVolume()).toBeCloseTo(1, 5);
  });

  it('keeps an in-progress fade-out continuous when the rate changes', () => {
    player.setPlaybackRate(1);
    const halfway = DURATION_MS - (CROSSFADE_MS / 2);
    source.setPosition(halfway, false);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);

    // Changing the rate mid-fade must not jump the gain: it stays where the
    // fade had advanced to, and the remaining fade simply runs at the new rate.
    player.setPlaybackRate(2);
    source.setPosition(halfway, false);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);

    // Advancing 2000 ms of track position inside the preserved 5000 ms window
    // leaves 500 ms of it, i.e. a gain of 0.1 (it was 0.5 at the rate change).
    source.setPosition(halfway + 2000, false);
    expect(source.getVolume()).toBeCloseTo(0.1, 5);

    // And the end of the original window is still silent.
    source.setPosition(DURATION_MS, false);
    expect(source.getVolume()).toBeCloseTo(0, 5);

    // The fade does not restart: no new window opens behind the playhead.
    player.setPlaybackRate(1);
    source.setPosition(DURATION_MS - (CROSSFADE_MS * 2), false);
    expect(source.getVolume()).toBeCloseTo(1, 5);
  });

  it('keeps an in-progress fade-in continuous when the rate changes', () => {
    player.setPlaybackRate(1);
    source.setPosition(CROSSFADE_MS / 2, false);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);

    player.setPlaybackRate(2);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);

    // Still inside the preserved 5000 ms window: at position 4000 the linear
    // fade-in gain is 4000/5000 = 0.8.
    source.setPosition(CROSSFADE_MS * 0.8, false);
    expect(source.getVolume()).toBeCloseTo(0.8, 5);
  });

  it('does not re-open a completed fade-in when the rate changes', () => {
    player.setPlaybackRate(1);
    source.setPosition(CROSSFADE_MS * 1.2, false); // fade-in long over
    expect(source.getVolume()).toBeCloseTo(1, 5);

    player.setPlaybackRate(2);
    // A fresh 2x window would be 10000 ms and the playhead is at 6000 ms, which
    // would put it back inside the fade-in under a naive recompute.
    source.setPosition(CROSSFADE_MS * 1.2, false);
    expect(source.getVolume()).toBeCloseTo(1, 5);
  });

  it('schedules the ended callback at the start of the fade-out', async() => {
    player.setPlaybackRate(1);
    await playAndSettle(source);
    window.setTimeout.mockClear();

    source.setPosition(DURATION_MS - 60000, false);
    source.setPlaybackRate(1);
    // At 1x the callback precedes the track end by the 5 s fade-out.
    expect(lastTimeoutDelay()).toBeCloseTo(55000, 5);

    window.setTimeout.mockClear();
    player.setPlaybackRate(2);
    // setPlaybackRate() ticks first, which can move the playhead a little, so
    // derive the expectation from the live position.  The callback must land
    // at the same instant the gain starts dropping: the point where the
    // remaining track equals the 2x fade-out window (10 s of track position),
    // converted to real seconds at 2x.
    const remainingMS = DURATION_MS - source.getPosition();
    const expectedMS = (remainingMS - (CROSSFADE_MS * 2)) / 2;
    expect(lastTimeoutDelay()).toBeCloseTo(expectedMS, 5);

    // Cross-check against the volume curve: just before the callback fires the
    // gain is still full, and it begins falling exactly then.
    const callback = window.setTimeout.mock.calls[window.setTimeout.mock.calls.length - 1][0];
    expect(callback).toBeInstanceOf(Function);

    source.setPosition(DURATION_MS - (CROSSFADE_MS * 2), false);
    expect(source.getVolume()).toBeCloseTo(1, 5);
    source.setPosition((DURATION_MS - (CROSSFADE_MS * 2)) + 1, false);
    expect(source.getVolume()).toBeLessThan(1);
  });

  it('clamps an over-long crossfade and applies the clamp in real time', () => {
    // Track is 100 s long, so 60 s + 60 s does not fit: clamp to 50 s each.
    source.setCrossfade(60000, 60000);

    // At 1x the clamped fade-out starts 50 s (real) before the end.
    player.setPlaybackRate(1);
    source.setPosition(DURATION_MS - 50000, false);
    expect(source.getVolume()).toBeCloseTo(1, 5);
    source.setPosition(DURATION_MS - 25000, false);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);
    source.setPosition(DURATION_MS, false);
    expect(source.getVolume()).toBeCloseTo(0, 5);
  });

  it('clamps against the real track duration at a non-1.0 rate', () => {
    // At 2x the track only lasts 50 s of real time, so 120 s of crossfade is
    // clamped to 25 s each, which is half the track's real duration.
    player.setPlaybackRate(2);
    source.setCrossfade(60000, 60000);

    // The fade-out therefore covers 50 s of track position (25 s at 2x).
    source.setPosition(DURATION_MS - 50000, false);
    expect(source.getVolume()).toBeCloseTo(1, 5);
    source.setPosition(DURATION_MS - 25000, false);
    expect(source.getVolume()).toBeCloseTo(0.5, 5);
    source.setPosition(DURATION_MS, false);
    expect(source.getVolume()).toBeCloseTo(0, 5);
  });

  it('warns when the crossfade is clamped', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    audioInstances.length = 0;
    // The player captures console.warn when it is constructed, so start the
    // spy first and build a player that logs warnings.
    const { source: warnSource } = createLoadedSource({ logLevel: LogLevel.Warning });

    warnSource.setCrossfade(60000, 60000);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('Crossfade total exceeds duration');
    warnSpy.mockRestore();
  });
});


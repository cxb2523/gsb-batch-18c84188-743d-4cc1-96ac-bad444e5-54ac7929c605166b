import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

const MediaStoreContext = createContext<MediaStore | null>(null);

export enum MediaReadyState {
    HAVE_NOTHING = 0,
    HAVE_METADATA = 1,
    HAVE_CURRENT_DATA = 2,
    HAVE_FUTURE_DATA = 3,
    HAVE_ENOUGH_DATA = 4,
}

export enum MediaNetworkState {
    NETWORK_EMPTY = 0,
    NETWORK_IDLE = 1,
    NETWORK_LOADING = 2,
    NETWORK_NO_SOURCE = 3,
}

export type StoreListener = () => void;
export type StoreListenerUnsubscribe = () => void;

export interface StateStore<T> {
    getState: () => T;
    getServerSnapshot?: () => T;
    setState: (state: T) => void;
    subscribe: (callback: StoreListener) => StoreListenerUnsubscribe;
    /**
     * Re-read the value directly from the media element and notify listeners
     * if it changed. Used when the media element may have silently clamped or
     * rejected a change without emitting an event.
     */
    forceSync?: () => void;
}

/**
 * Tracks the target time of a seek that has not yet settled in the media
 * element. While `getState()` returns a number, playback UI displays that
 * target time instead of the media element's live `currentTime`.
 *
 * - `setState(time)` marks a programmatic (non-interactive) seek. It is
 *   cleared automatically by the next `seeked` event, or by a safety timeout
 *   when the media element rejects or clamps the request without seeking.
 * - `beginInteraction()` / `endInteraction()` bracket a drag or keyboard
 *   adjustment. `seeked` events emitted by intermediate seeks while an
 *   interaction is active do not clear the target time.
 */
export interface PendingSeekStore extends StateStore<number | null> {
    beginInteraction: () => void;
    endInteraction: () => void;
}

export function createStateStore<T>(initialState: T): StateStore<T> {
    let state = initialState;
    const listeners = new Set<StoreListener>();

    function getState() {
        return state;
    }

    function setState(newState: T) {
        state = newState;
        listeners.forEach((listener) => listener());
    }

    function subscribe(callback: StoreListener) {
        listeners.add(callback);
        return () => {
            listeners.delete(callback);
        };
    }

    return {
        getState,
        getServerSnapshot: () => initialState,
        setState,
        subscribe,
    };
}

export interface MediaStore {
    mediaElement: StateStore<HTMLMediaElement | null>;
    audioOnly: StateStore<boolean>;
    muted: StateStore<boolean>;
    readyState: StateStore<MediaReadyState>;
    networkState: StateStore<MediaNetworkState>;
    error: StateStore<MediaError | null>;
    ended: StateStore<boolean>;
    buffered: StateStore<TimeRanges | null>;
    seeking: StateStore<boolean>;
    seekable: StateStore<TimeRanges | null>;
    playing: StateStore<boolean>;
    loop: StateStore<boolean>;
    volume: StateStore<number>;
    playbackRate: StateStore<number>;
    duration: StateStore<number>;
    currentTime: StateStore<number>;
    pendingSeek: PendingSeekStore;
    fullscreen: StateStore<boolean>;
    opaque: (key: string) => StateStore<unknown>;
}

function timeRangesCompare(a: TimeRanges, b: TimeRanges) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a.start(i) !== b.start(i) || a.end(i) !== b.end(i)) return false;
    }
    return true;
}

function createMutedStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('volumechange', handler);
        
        cleanup = () => {
            element.removeEventListener('volumechange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            return mediaElement.getState()?.muted ?? false;
        },
        setState(muted) {
            const element = mediaElement.getState();
            if (!element) return;
            element.muted = muted;
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaReadyStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<MediaReadyState> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('abort', handler);
        element.addEventListener('canplay', handler);
        element.addEventListener('canplaythrough', handler);
        element.addEventListener('emptied', handler);
        element.addEventListener('error', handler);
        element.addEventListener('loadeddata', handler);
        element.addEventListener('loadedmetadata', handler);
        element.addEventListener('loadstart', handler);
        element.addEventListener('stalled', handler);
        element.addEventListener('suspend', handler);
        element.addEventListener('waiting', handler);
        element.addEventListener('seeking', handler);
        element.addEventListener('seeked', handler);
        element.addEventListener('ended', handler);
        
        cleanup = () => {
            element.removeEventListener('abort', handler);
            element.removeEventListener('canplay', handler);
            element.removeEventListener('canplaythrough', handler);
            element.removeEventListener('emptied', handler);
            element.removeEventListener('error', handler);
            element.removeEventListener('loadeddata', handler);
            element.removeEventListener('loadedmetadata', handler);
            element.removeEventListener('loadstart', handler);
            element.removeEventListener('stalled', handler);
            element.removeEventListener('suspend', handler);
            element.removeEventListener('waiting', handler);
            element.removeEventListener('seeking', handler);
            element.removeEventListener('seeked', handler);
            element.removeEventListener('ended', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return MediaReadyState.HAVE_NOTHING;
            return element.readyState;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaNetworkStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<MediaNetworkState> {
    const listeners = new Set<StoreListener>();
    let lastState: MediaNetworkState | null = null;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            if (!element) return;
            if (element.networkState === lastState) return;
            listeners.forEach((listener) => listener());
            lastState = element.networkState;
        };
        element.addEventListener('loadstart', handler);
        element.addEventListener('suspend', handler);
        element.addEventListener('abort', handler);
        element.addEventListener('error', handler);
        element.addEventListener('emptied', handler);
        element.addEventListener('stalled', handler);
        element.addEventListener('loadedmetadata', handler);
        element.addEventListener('loadeddata', handler);
        element.addEventListener('canplay', handler);
        element.addEventListener('canplaythrough', handler);
        element.addEventListener('waiting', handler);
        element.addEventListener('seeking', handler);
        element.addEventListener('seeked', handler);
        element.addEventListener('ended', handler);
        element.addEventListener('progress', handler);
        
        cleanup = () => {
            element.removeEventListener('loadstart', handler);
            element.removeEventListener('suspend', handler);
            element.removeEventListener('abort', handler);
            element.removeEventListener('error', handler);
            element.removeEventListener('emptied', handler);
            element.removeEventListener('stalled', handler);
            element.removeEventListener('loadedmetadata', handler);
            element.removeEventListener('loadeddata', handler);
            element.removeEventListener('canplay', handler);
            element.removeEventListener('canplaythrough', handler);
            element.removeEventListener('waiting', handler);
            element.removeEventListener('seeking', handler);
            element.removeEventListener('seeked', handler);
            element.removeEventListener('ended', handler);
            element.removeEventListener('progress', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return MediaNetworkState.NETWORK_EMPTY;
            return element.networkState;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaErrorStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<MediaError | null> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('error', handler);
        
        cleanup = () => {
            element.removeEventListener('error', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return null;
            return element.error;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaEndedStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('ended', handler);
        element.addEventListener('seeked', handler);
        element.addEventListener('play', handler);
        element.addEventListener('durationchange', handler);
        
        cleanup = () => {
            element.removeEventListener('ended', handler);
            element.removeEventListener('seeked', handler);
            element.removeEventListener('play', handler);
            element.removeEventListener('durationchange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return false;
            return element.ended;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaBufferedStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<TimeRanges | null> {
    const listeners = new Set<StoreListener>();
    let lastRanges: TimeRanges | null = null;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            if (!element?.buffered) return;
            if (lastRanges && timeRangesCompare(element.buffered, lastRanges)) return;
            lastRanges = element?.buffered ?? null;
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('progress', handler);
        
        cleanup = () => {
            element.removeEventListener('progress', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return null;
            return lastRanges;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

export function createMediaSeekingStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let lastSeeking: boolean = false;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            if (element?.seeking === lastSeeking) return;
            listeners.forEach((listener) => listener());
            lastSeeking = element?.seeking ?? false;
        };
        element.addEventListener('seeking', handler);
        element.addEventListener('seeked', handler);
        
        cleanup = () => {
            element.removeEventListener('seeking', handler);
            element.removeEventListener('seeked', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return false;
            return element.seeking;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

export function createMediaSeekableStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<TimeRanges | null> {
    const listeners = new Set<StoreListener>();
    let lastRanges: TimeRanges | null = null;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            if (!element?.seekable) return;
            if (!lastRanges) return;
            if (timeRangesCompare(element.seekable, lastRanges)) return;
            lastRanges = element?.seekable ?? null;
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('seeking', handler);
        element.addEventListener('seeked', handler);
        element.addEventListener('progress', handler);
        element.addEventListener('canplay', handler);
        element.addEventListener('canplaythrough', handler);
        
        cleanup = () => {
            element.removeEventListener('seeking', handler);
            element.removeEventListener('seeked', handler);
            element.removeEventListener('progress', handler);
            element.removeEventListener('canplay', handler);
            element.removeEventListener('canplaythrough', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return null;
            return lastRanges;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaPlayingStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('play', handler);
        element.addEventListener('pause', handler);

        cleanup = () => {
            element.removeEventListener('play', handler);
            element.removeEventListener('pause', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return false;
            return !element.paused;
        },
        setState(playing) {
            const element = mediaElement.getState();
            if (!element) return;
            if (playing && element.paused) element.play();
            if (!playing && !element.paused) element.pause();
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaLoopStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return false;
            return element.loop;
        },
        setState(loop) {
            const element = mediaElement.getState();
            if (!element) return;
            element.loop = loop;
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaVolumeStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<number> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('volumechange', handler);

        cleanup = () => {
            element.removeEventListener('volumechange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return 1;
            return element.volume;
        },
        setState(volume) {
            const element = mediaElement.getState();
            if (!element) return;
            element.volume = Math.max(0, Math.min(1, volume));
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaPlaybackRateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<number> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('ratechange', handler);
        
        cleanup = () => {
            element.removeEventListener('ratechange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return 1;
            return element.playbackRate;
        },
        setState(rate) {
            const element = mediaElement.getState();
            if (!element) return;
            element.playbackRate = rate;
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaDurationStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<number> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('durationchange', handler);
        
        cleanup = () => {
            element.removeEventListener('durationchange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return 0;
            if (Number.isNaN(element.duration)) return 0;
            return element.duration;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaCurrentTimeStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<number> {
    const listeners = new Set<StoreListener>();
    let currentTime = 0;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function update() {
        const nextTime = mediaElement.getState()?.currentTime ?? 0;
        if (nextTime === currentTime) return;
        currentTime = nextTime;
        listeners.forEach(listener => listener());
    }

    function forceSync() {
        const nextTime = mediaElement.getState()?.currentTime ?? 0;
        if (nextTime === currentTime) return;
        currentTime = nextTime;
        listeners.forEach(listener => listener());
    }

    function detectChanges() {
        cleanup();
        update();
        const element = mediaElement.getState();
        if (!element) return;
        const events = ['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'emptied'];
        events.forEach(event => element.addEventListener(event, update));
        cleanup = () => events.forEach(event => element.removeEventListener(event, update));
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            return currentTime;
        },
        setState(time) {
            const element = mediaElement.getState();
            if (!element) return;
            if (!Number.isFinite(time) || Number.isNaN(time)) return;
            if (!Number.isFinite(element.duration) || Number.isNaN(element.duration)) return;
            element.currentTime = Math.min(Math.max(time, 0), element.duration);
            update();
        },
        forceSync,
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

export function createMediaPendingSeekStore(
    mediaElement: StateStore<HTMLMediaElement | null>,
    currentTimeStore: StateStore<number>,
): PendingSeekStore {
    const listeners = new Set<StoreListener>();
    let pendingSeek: number | null = null;
    let interacting = false;
    let cleanup: StoreListenerUnsubscribe = () => {};
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let seekGeneration = 0;

    function clearFallbackTimer() {
        if (fallbackTimer !== undefined) {
            clearTimeout(fallbackTimer);
            fallbackTimer = undefined;
        }
    }

    function notify() {
        listeners.forEach(listener => listener());
    }

    function clearPending() {
        seekGeneration++;
        clearFallbackTimer();
        if (pendingSeek === null) return;
        pendingSeek = null;
        notify();
    }

    function detectChanges() {
        cleanup();
        clearFallbackTimer();
        seekGeneration++;
        pendingSeek = null;
        interacting = false;

        const element = mediaElement.getState();
        if (!element) return;

        function handleSeeked() {
            // While the user is still dragging, intermediate seeks must not
            // clear the target time their UI is anchored to. Once the
            // interaction has ended, every seeked re-syncs the cached time so
            // an async clamp is reflected even if the commit ran before the
            // media finished seeking.
            if (interacting) return;
            currentTimeStore.forceSync?.();
            clearPending();
        }

        element.addEventListener('seeked', handleSeeked);
        cleanup = () => {
            element.removeEventListener('seeked', handleSeeked);
            clearFallbackTimer();
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            return pendingSeek;
        },
        setState(time) {
            const element = mediaElement.getState();
            if (time === null || !Number.isFinite(time) || Number.isNaN(time)) {
                clearPending();
                return;
            }
            const generation = ++seekGeneration;
            pendingSeek = time;
            clearFallbackTimer();
            // The media element may reject or silently clamp a seek (for
            // example when the target lies outside the seekable ranges), in
            // which case no `seeked` event may ever fire. Fall back to the
            // media's own current time after a safety delay unless the user is
            // actively interacting (the interaction end clears the state).
            if (!interacting) {
                fallbackTimer = setTimeout(() => {
                    if (generation !== seekGeneration) return;
                    fallbackTimer = undefined;
                    currentTimeStore.forceSync?.();
                    clearPending();
                }, 1000);
            }
            notify();
        },
        beginInteraction() {
            interacting = true;
            clearFallbackTimer();
        },
        endInteraction() {
            if (!interacting) return;
            interacting = false;
            // Re-align the display with the media element's actual current
            // time immediately, honouring any rejection or clamping. Do not
            // wait for a `seeked` event: a clamped or rejected seek may never
            // emit one, and intermediate seeks while interacting were
            // deliberately ignored above.
            currentTimeStore.forceSync?.();
            clearPending();
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        }
    }
}

type NativeFullscreenMediaElement = HTMLMediaElement & {
    webkitDisplayingFullscreen?: boolean;
    webkitEnterFullscreen?: () => void;
    webkitExitFullscreen?: () => void;
};

function createMediaFullscreenStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        if (listeners.size === 0) return;
        cleanup();

        const element = mediaElement.getState();
        function handler() {
            listeners.forEach((listener) => listener());
        }

        element?.addEventListener('webkitbeginfullscreen', handler);
        element?.addEventListener('webkitendfullscreen', handler);
        document.addEventListener('fullscreenchange', handler);
        // vendor prefixes for fullscreenchange
        document.addEventListener('webkitfullscreenchange', handler);
        document.addEventListener('mozfullscreenchange', handler);
        document.addEventListener('MSFullscreenChange', handler);

        cleanup = () => {
            element?.removeEventListener('webkitbeginfullscreen', handler);
            element?.removeEventListener('webkitendfullscreen', handler);
            document.removeEventListener('fullscreenchange', handler);
            document.removeEventListener('webkitfullscreenchange', handler);
            document.removeEventListener('mozfullscreenchange', handler);
            document.removeEventListener('MSFullscreenChange', handler);
        };
    }
    
    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState() as NativeFullscreenMediaElement | null;
            if (!element) return false;
            // @ts-ignore
            const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

            return element.webkitDisplayingFullscreen === true || fullscreenElement === element.parentElement;
        },
        setState(fullscreen) {
            const element = mediaElement.getState() as NativeFullscreenMediaElement | null;
            if (!element) return;
            if (element.parentElement?.getAttribute('data-media-container') !== 'true') 
                throw new Error('Fullscreen only works if the media element is inside a media container');
            // @ts-ignore
            const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

            // @ts-ignore
            const enterFullscreen = element.parentElement?.requestFullscreen || element.parentElement?.webkitRequestFullscreen || element.parentElement?.mozRequestFullScreen || element.parentElement?.msRequestFullscreen;
            // @ts-ignore
            const exitFullscreen = document.exitFullscreen || document.webkitCancelFullScreen || document.mozCancelFullScreen || document.msExitFullscreen;

            try {
                if (!fullscreen && element.webkitDisplayingFullscreen) {
                    element.webkitExitFullscreen?.();
                } else if (!fullscreen && fullscreenElement === element.parentElement) {
                    exitFullscreen?.call(document)?.catch(() => { });
                } else if (fullscreen && enterFullscreen) {
                    enterFullscreen.call(element.parentElement)?.catch(() => { });
                } else if (fullscreen) {
                    element.webkitEnterFullscreen?.();
                }
            } catch {
                return;
            }
            
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            if (listeners.size === 1) detectChanges();
            return () => {
                listeners.delete(callback);
                if (listeners.size === 0) cleanup();
            }
        },
    }
}

export function createMediaStore(): MediaStore {
    const mediaElement = createStateStore<HTMLMediaElement | null>(null);

    function withMediaSnapshot<T>(store: StateStore<T>): StateStore<T> {
        const snapshot = store.getState();
        // Keep a dedicated listener set so imperative methods exposed on the
        // wrapped store notify the same callbacks React subscribes through.
        // Forwarding directly to the underlying store's `forceSync` would
        // notify its own listeners, which the wrapped subscribe path does not
        // share.
        const listeners = new Set<StoreListener>();
        const wrapped: StateStore<T> = {
            ...store,
            getServerSnapshot: () => snapshot,
            subscribe(callback) {
                listeners.add(callback);
                const unsubscribeStore = store.subscribe(callback);
                const unsubscribeElement = mediaElement.subscribe(callback);
                return () => {
                    listeners.delete(callback);
                    unsubscribeStore();
                    unsubscribeElement();
                };
            },
        };
        if (store.forceSync) {
            wrapped.forceSync = () => {
                store.forceSync?.();
                listeners.forEach(listener => listener());
            };
        }
        return wrapped;
    }

    function withPendingSeekSnapshot(store: PendingSeekStore): PendingSeekStore {
        return {
            ...withMediaSnapshot(store),
            beginInteraction: store.beginInteraction,
            endInteraction: store.endInteraction,
        } as PendingSeekStore;
    }

    const opaqueStores = new Map<string, StateStore<unknown>>();

    const currentTimeStore = withMediaSnapshot(createMediaCurrentTimeStore(mediaElement));
    const pendingSeekStore = withPendingSeekSnapshot(createMediaPendingSeekStore(mediaElement, currentTimeStore));

    return {
        mediaElement,
        audioOnly: {
            getState() {
                return mediaElement.getState()?.tagName === 'AUDIO';
            },
            getServerSnapshot: () => false,
            setState() {
                // Do nothing
            },
            subscribe(callback) {
                return mediaElement.subscribe(callback);
            },
        },
        muted: withMediaSnapshot(createMutedStore(mediaElement)),
        readyState: withMediaSnapshot(createMediaReadyStateStore(mediaElement)),
        networkState: withMediaSnapshot(createMediaNetworkStateStore(mediaElement)),
        error: withMediaSnapshot(createMediaErrorStateStore(mediaElement)),
        ended: withMediaSnapshot(createMediaEndedStateStore(mediaElement)),
        buffered: withMediaSnapshot(createMediaBufferedStateStore(mediaElement)),
        seeking: withMediaSnapshot(createMediaSeekingStore(mediaElement)),
        seekable: withMediaSnapshot(createMediaSeekableStore(mediaElement)),
        playing: withMediaSnapshot(createMediaPlayingStore(mediaElement)),
        loop: withMediaSnapshot(createMediaLoopStore(mediaElement)),
        volume: withMediaSnapshot(createMediaVolumeStore(mediaElement)),
        playbackRate: withMediaSnapshot(createMediaPlaybackRateStore(mediaElement)),
        duration: withMediaSnapshot(createMediaDurationStore(mediaElement)),
        currentTime: currentTimeStore,
        pendingSeek: pendingSeekStore,
        fullscreen: withMediaSnapshot(createMediaFullscreenStore(mediaElement)),
        opaque: (key: string) => {
            if (opaqueStores.has(key)) 
                return opaqueStores.get(key)!;

            const store = createStateStore<unknown>(null);
            opaqueStores.set(key, store);

            return store;
        }
    }
}

export function useMediaStore() {
    const store = useContext(MediaStoreContext);
    if (!store) {
        throw new Error('useMediaStore must be used within a MediaStoreProvider');
    }
    return store;
}

export function MediaStoreProvider({ children }: { children: React.ReactNode }) {
    const store = useMemo(() => createMediaStore(), []);
    return <MediaStoreContext.Provider value={store}>{children}</MediaStoreContext.Provider>;
}

export function useStateStoreValue<T>(store: StateStore<T>): T {
    return useSyncExternalStore(store.subscribe, store.getState, store.getServerSnapshot ?? store.getState);
}

export function useStateStore<T>(store: StateStore<T>): readonly [T, (value: T) => void] {
    return [useStateStoreValue(store), store.setState] as const;
}

export function useMediaOpaque(key: string) {
    const store = useMediaStore();

    return useStateStore(store.opaque(key));
}

export function useMediaElement() {
    const store = useMediaStore();
    return useStateStoreValue(store.mediaElement);
}

export function useMediaElementState() {
    const store = useMediaStore();
    return useStateStore(store.mediaElement);
}

export function useMediaAudioOnly() {
    const store = useMediaStore();
    return useStateStoreValue(store.audioOnly);
}

export function useMediaMuted() {
    const store = useMediaStore();
    return useStateStore(store.muted);
}

export function useMediaReadyState() {
    const store = useMediaStore();
    return useStateStoreValue(store.readyState);
}

export function useMediaNetworkState() {
    const store = useMediaStore();
    return useStateStoreValue(store.networkState);
}

export function useMediaError() {
    const store = useMediaStore();
    return useStateStoreValue(store.error);
}

export function useMediaEnded() {
    const store = useMediaStore();
    return useStateStoreValue(store.ended);
}

export function useMediaBuffered() {
    const store = useMediaStore();
    return useStateStoreValue(store.buffered);
}

export function useMediaSeeking() {
    const store = useMediaStore();
    return useStateStoreValue(store.seeking);
}

export function useMediaSeekable() {
    const store = useMediaStore();
    return useStateStoreValue(store.seekable);
}

export function useMediaPlaying() {
    const store = useMediaStore();
    return useStateStore(store.playing);
}

export function useMediaLoop() {
    const store = useMediaStore();
    return useStateStore(store.loop);
}

export function useMediaVolume() {
    const store = useMediaStore();
    return useStateStore(store.volume);
}

export function useMediaPlaybackRate(initialRate?: number) {
    const store = useMediaStore();
    const pendingInitialRate = useRef(initialRate);

    useEffect(() => {
        if (pendingInitialRate.current === undefined) return;

        function applyInitialRate() {
            if (!store.mediaElement.getState() || pendingInitialRate.current === undefined) return;
            store.playbackRate.setState(pendingInitialRate.current);
            pendingInitialRate.current = undefined;
            unsubscribe();
        }

        const unsubscribe = store.mediaElement.subscribe(applyInitialRate);
        applyInitialRate();
        return unsubscribe;
    }, [store]);

    return useStateStore(store.playbackRate);
}

export function useMediaDuration() {
    const store = useMediaStore();
    return useStateStoreValue(store.duration);
}

export function useMediaCurrentTime() {
    const store = useMediaStore();
    const currentTime = useStateStoreValue(store.currentTime);
    const pendingSeek = useStateStoreValue(store.pendingSeek);
    const seek = useCallback((time: number) => {
        store.pendingSeek.setState(time);
        store.currentTime.setState(time);
    }, [store]);
    return [pendingSeek ?? currentTime, seek] as const;
}

export function useMediaPendingSeek() {
    const store = useMediaStore();
    const pendingSeek = useStateStoreValue(store.pendingSeek);
    return [
        pendingSeek,
        store.pendingSeek.setState,
        {
            beginInteraction: store.pendingSeek.beginInteraction,
            endInteraction: store.pendingSeek.endInteraction,
        },
    ] as const;
}

/**
 * The time that playback UI should display. While a seek initiated by the user
 * is in flight, the user's target time is shown instead of the media element's
 * live `currentTime`, so `timeupdate` events cannot drag the UI backwards
 * mid-drag. Once the seek settles (or is rejected/clamped by the media element)
 * the display falls back to the media element's actual `currentTime`.
 */
export function useMediaDisplayCurrentTime() {
    const store = useMediaStore();
    const currentTime = useStateStoreValue(store.currentTime);
    const pendingSeek = useStateStoreValue(store.pendingSeek);
    return pendingSeek ?? currentTime;
}

export function useMediaCurrentTimeFine() {
    const store = useMediaStore();
    const element = useMediaElement();
    const pendingSeek = useStateStoreValue(store.pendingSeek);
    const currentTime = useStateStoreValue(store.currentTime);

    useEffect(() => {
        if (!element) return;
        const media = element;
        let handle: number | undefined;

        // The rAF loop keeps the store's cached current time advancing while
        // playback is running; the actual rendered value comes from the store
        // via useSyncExternalStore above, so paused seeks and forced re-syncs
        // are reflected immediately without depending on this loop.
        function tick() {
            store.currentTime.forceSync?.();
            handle = undefined;
            if (!media.paused && !media.ended)
                handle = requestAnimationFrame(tick);
        }

        function handlePlaybackChange() {
            if (handle !== undefined) cancelAnimationFrame(handle);
            tick();
        }

        const events = ['play', 'pause', 'ended'];
        events.forEach(event => media.addEventListener(event, handlePlaybackChange));
        handlePlaybackChange();

        return () => {
            if (handle !== undefined) cancelAnimationFrame(handle);
            events.forEach(event => media.removeEventListener(event, handlePlaybackChange));
        }
    }, [element, store]);

    const seek = useCallback((time: number) => {
        store.pendingSeek.setState(time);
        store.currentTime.setState(time);
    }, [store]);

    return [pendingSeek ?? currentTime, seek] as const;
}

export function useMediaFullscreen() {
    const store = useMediaStore();
    return useStateStore(store.fullscreen);
}

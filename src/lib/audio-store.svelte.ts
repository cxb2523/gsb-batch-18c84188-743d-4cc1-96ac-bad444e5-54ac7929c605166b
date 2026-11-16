import { createContext } from "svelte";
import { type HtmlAudio, type Track } from "$lib/html-audio.js";

export type RepeatMode = "none" | "one" | "all";
export type InsertMode = "first" | "last" | "after";

// ─── Context ─────────────────────────────────────────────────────────────────

export const [getAudioContext, setAudioContext] = createContext<AudioStore>();

// ─── Helper functions ────────────────────────────────────────────────────────

export function canUseDOM(): boolean {
	return typeof window !== "undefined" && !!window.document?.createElement;
}

type QueueNavigationParams = {
	queue: Track[];
	currentQueueIndex: number;
	shuffleEnabled: boolean;
	repeatMode: RepeatMode;
};

function getRandomShuffleIndex(queueLength: number, currentIndex: number): number {
	if (queueLength === 1) return 0;
	let idx: number;
	do {
		idx = Math.floor(Math.random() * queueLength);
	} while (idx === currentIndex);
	return idx;
}

function calculateQueueIndex(params: QueueNavigationParams & { direction: 1 | -1 }): number {
	const { queue, currentQueueIndex, shuffleEnabled, repeatMode, direction } = params;
	if (queue.length === 0) return -1;
	if (shuffleEnabled) {
		if (queue.length === 1) return repeatMode === "none" ? -1 : 0;
		return getRandomShuffleIndex(queue.length, currentQueueIndex);
	}
	const next = currentQueueIndex + direction;
	if (next >= queue.length) return repeatMode === "all" ? 0 : -1;
	if (next < 0) return repeatMode === "all" ? queue.length - 1 : -1;
	return next;
}

export function calculateNextIndex(params: QueueNavigationParams): number {
	return calculateQueueIndex({ ...params, direction: 1 });
}

export function calculatePreviousIndex(params: QueueNavigationParams): number {
	return calculateQueueIndex({ ...params, direction: -1 });
}

/**
 * Locates `track` inside `queue` by id (preferred), object identity, then url.
 * Returns -1 when the track is not part of the queue. Consumers use this to
 * keep `currentQueueIndex` anchored to `currentTrack` after queue mutations.
 */
export function findTrackQueueIndex(queue: Track[], track: Track | null): number {
	if (!track) return -1;
	if (track.id !== undefined) {
		const byId = queue.findIndex((entry) => String(entry.id) === String(track.id));
		if (byId !== -1) return byId;
	}
	const byReference = queue.indexOf(track);
	if (byReference !== -1) return byReference;
	if (track.url) {
		// Tracks rehydrated from storage are distinct objects; match by url as a
		// last resort so the index still tracks the playing entry.
		const byUrl = queue.findIndex((entry) => entry.url === track.url);
		if (byUrl !== -1) return byUrl;
	}
	return -1;
}

// ─── Store ───────────────────────────────────────────────────────────────────

const DEFAULT_STORAGE_KEY = "audio:ui:store";

export class AudioStore {
	readonly htmlAudio: HtmlAudio;
	private readonly storageKey: string | null;

	// ── Reactive state ──────────────────────────────────────────────────────
	currentTrack: Track | null = $state(null);
	queue: Track[] = $state([]);
	isPlaying = $state(false);
	isLoading = $state(false);
	isBuffering = $state(false);
	volume = $state(1);
	isMuted = $state(false);
	playbackRate = $state(1);
	repeatMode: RepeatMode = $state("none");
	shuffleEnabled = $state(false);
	currentTime = $state(0);
	duration = $state(0);
	progress = $state(0);
	bufferedTime = $state(0);
	insertMode: InsertMode = $state("last");
	isError = $state(false);
	errorMessage: string | null = $state(null);
	currentQueueIndex = $state(-1);

	// ── Derived ─────────────────────────────────────────────────────────────
	get isLive(): boolean {
		return this.htmlAudio.isLive(this.duration);
	}

	constructor(htmlAudio: HtmlAudio, storageKey?: string | null) {
		this.htmlAudio = htmlAudio;
		this.storageKey = storageKey === undefined ? DEFAULT_STORAGE_KEY : storageKey;
		if (canUseDOM() && this.storageKey) this.loadFromStorage();
	}

	// ── Queue index synchronization ─────────────────────────────────────────

	/**
	 * Resolves the queue position of the currently playing track by identity
	 * (id when available, object identity as a fallback).
	 */
	private resolveCurrentQueueIndex(): number {
		return findTrackQueueIndex(this.queue, this.currentTrack);
	}

	/**
	 * Re-points `currentQueueIndex` at `currentTrack` after a queue mutation.
	 * Exposed so provider-level queue swaps can keep the pair consistent too.
	 */
	syncCurrentQueueIndex(): void {
		this.currentQueueIndex = this.resolveCurrentQueueIndex();
	}

	/** Clears playback state when the queue no longer contains any track. */
	private resetForEmptyQueue(): void {
		this.currentTrack = null;
		this.currentQueueIndex = -1;
		this.isPlaying = false;
		this.isLoading = false;
		this.isBuffering = false;
		this.currentTime = 0;
		this.duration = 0;
		this.progress = 0;
		this.bufferedTime = 0;
		try {
			this.htmlAudio.pause();
		} catch {
			/* audio may not be initialized in non-browser environments */
		}
	}

	// ── Persistence ─────────────────────────────────────────────────────────

	loadFromStorage(): void {
		if (!this.storageKey) return;
		try {
			const raw = localStorage.getItem(this.storageKey);
			if (!raw) return;
			const d = JSON.parse(raw);
			if (d.currentTrack !== undefined) this.currentTrack = d.currentTrack ?? null;
			if (d.queue !== undefined) this.queue = Array.isArray(d.queue) ? d.queue : [];
			if (d.volume !== undefined) this.volume = d.volume;
			if (d.isMuted !== undefined) this.isMuted = d.isMuted;
			if (d.playbackRate !== undefined) this.playbackRate = d.playbackRate;
			if (d.repeatMode !== undefined) this.repeatMode = d.repeatMode;
			if (d.shuffleEnabled !== undefined) this.shuffleEnabled = d.shuffleEnabled;
			if (d.currentTime !== undefined) this.currentTime = d.currentTime;
			if (d.insertMode !== undefined) this.insertMode = d.insertMode;
			if (d.currentQueueIndex !== undefined) this.currentQueueIndex = d.currentQueueIndex;

			// Restored index may be stale (e.g. persisted by an older build).
			// Derive it from the restored track so "next"/"previous" resume correctly.
			this.syncCurrentQueueIndex();

			if (this.duration > 0) {
				this.progress = (this.currentTime / this.duration) * 100;
			}
		} catch {
			/* ignore */
		}
	}

	saveToStorage(): void {
		if (!canUseDOM() || !this.storageKey) return;
		try {
			// Guarantee the persisted pair is consistent: the saved index always
			// points at the saved track (or -1 when there is no active track).
			this.syncCurrentQueueIndex();
			localStorage.setItem(
				this.storageKey,
				JSON.stringify({
					currentTrack: this.currentTrack,
					queue: this.queue,
					volume: this.volume,
					isMuted: this.isMuted,
					playbackRate: this.playbackRate,
					repeatMode: this.repeatMode,
					shuffleEnabled: this.shuffleEnabled,
					currentTime: this.currentTime,
					insertMode: this.insertMode,
					currentQueueIndex: this.currentQueueIndex,
				})
			);
		} catch {
			/* ignore */
		}
	}

	// ── Playback actions ────────────────────────────────────────────────────

	play(): void {
		if (this.isLoading) return;
		this.isPlaying = true;
		this.htmlAudio.play().catch(() => {});
	}

	pause(): void {
		this.isPlaying = false;
		this.htmlAudio.pause();
	}

	togglePlay(): void {
		if (this.isLoading) return;
		if (this.isPlaying) {
			this.pause();
		} else {
			this.play();
		}
	}

	seek(time: number): void {
		const valid = this.duration > 0 ? Math.max(0, Math.min(time, this.duration)) : time;
		this.currentTime = valid;
		this.progress = this.duration > 0 ? (valid / this.duration) * 100 : 0;
	}

	next(): void {
		// Guard against a stale index (e.g. queue replaced externally) before navigating.
		this.syncCurrentQueueIndex();
		const idx = calculateNextIndex({
			queue: this.queue,
			currentQueueIndex: this.currentQueueIndex,
			shuffleEnabled: this.shuffleEnabled,
			repeatMode: this.repeatMode,
		});
		const track = this.queue[idx];
		if (idx === -1 || !track) {
			this.isLoading = false;
			this.isPlaying = false;
			this.isBuffering = false;
			return;
		}
		this.loadAndPlayTrack(track, idx);
	}

	previous(): void {
		if (this.currentTime > 3 && !this.shuffleEnabled) {
			this.currentTime = 0;
			this.progress = 0;
			return;
		}
		// Guard against a stale index before navigating backwards.
		this.syncCurrentQueueIndex();
		const idx = calculatePreviousIndex({
			queue: this.queue,
			currentQueueIndex: this.currentQueueIndex,
			shuffleEnabled: this.shuffleEnabled,
			repeatMode: this.repeatMode,
		});
		const track = this.queue[idx];
		if (idx === -1 || !track) {
			this.isLoading = false;
			this.isPlaying = false;
			this.isBuffering = false;
			return;
		}
		this.loadAndPlayTrack(track, idx);
	}

	setQueueAndPlay(songs: Track[], startIndex: number): void {
		const target = songs[startIndex];
		if (!target) {
			// Nothing to play at that position — reset to a consistent empty state.
			this.clearQueue();
			this.isPlaying = false;
			this.isLoading = false;
			this.isBuffering = false;
			return;
		}
		this.setQueue(songs, startIndex);
		const idx = this.currentQueueIndex;
		if (idx === -1) {
			// setQueue rejected the index (out of range) despite a defined entry.
			this.isPlaying = false;
			this.isLoading = false;
			this.isBuffering = false;
			return;
		}
		this.loadAndPlayTrack(this.queue[idx] ?? target, idx);
	}

	handleTrackEnd(): void {
		this.next();
	}

	// ── Queue actions ───────────────────────────────────────────────────────

	setQueue(tracks: Track[], startIndex = 0): void {
		const nextQueue = Array.isArray(tracks) ? [...tracks] : [];
		this.queue = nextQueue;

		if (nextQueue.length === 0) {
			this.resetForEmptyQueue();
			return;
		}

		// A negative or out-of-range start means "no active entry" — keep the queue
		// intact but leave the index at -1 rather than inventing a position.
		const index =
			Number.isInteger(startIndex) && startIndex >= 0 && startIndex < nextQueue.length
				? startIndex
				: -1;

		this.currentTrack = index === -1 ? null : (nextQueue[index] ?? null);
		this.currentQueueIndex = this.currentTrack ? index : -1;
	}

	getCurrentQueueIndex(): number {
		return this.currentQueueIndex;
	}

	addToQueue(track: Track, mode: InsertMode = "last"): void {
		if (!this.currentTrack) {
			this.currentTrack = track;
			this.currentQueueIndex = 0;
			this.queue = [track];
			return;
		}
		// Re-derive first: the stored index can be stale after other mutations.
		this.syncCurrentQueueIndex();
		switch (mode) {
			case "first":
				this.queue = [track, ...this.queue];
				break;
			case "after": {
				const insertAt = Math.max(0, this.currentQueueIndex + 1);
				this.queue = [
					...this.queue.slice(0, insertAt),
					track,
					...this.queue.slice(insertAt),
				];
				break;
			}
			default:
				this.queue = [...this.queue, track];
		}
		// Insertion may have shifted the current track's position.
		this.syncCurrentQueueIndex();
	}

	removeFromQueue(trackId: string): void {
		const key = String(trackId);
		const matchesId = (track: Track): boolean =>
			track.id !== undefined && String(track.id) === key;

		const removedIndex = this.queue.findIndex(matchesId);
		if (removedIndex === -1) return;

		const current = this.currentTrack;
		const removingCurrent =
			current !== null && (matchesId(current) || this.queue[removedIndex] === current);

		this.queue = this.queue.filter((track) => !matchesId(track));

		if (!removingCurrent) {
			// The playing track only shifted left; pin the index back onto it.
			this.syncCurrentQueueIndex();
			return;
		}

		if (this.queue.length === 0) {
			this.resetForEmptyQueue();
			return;
		}

		// The playing track is gone: continue at the entry that took its slot,
		// or at the new last entry when it was the final one.
		const nextIndex = Math.min(removedIndex, this.queue.length - 1);
		this.currentTrack = this.queue[nextIndex] ?? null;
		this.currentQueueIndex = this.currentTrack ? nextIndex : -1;
		this.isError = false;
		this.errorMessage = null;
	}

	clearQueue(): void {
		this.queue = [];
		this.resetForEmptyQueue();
	}

	moveInQueue(fromIndex: number, toIndex: number): void {
		if (fromIndex < 0 || fromIndex >= this.queue.length) return;
		const q = [...this.queue];
		const [item] = q.splice(fromIndex, 1);
		if (!item) return;
		const safeTo = Math.max(0, Math.min(toIndex, q.length));
		q.splice(safeTo, 0, item);
		this.queue = q;
		// Keep the index on the same track after the reorder.
		this.syncCurrentQueueIndex();
	}

	addTracksToEndOfQueue(tracks: Track[]): void {
		if (!tracks?.length) return;
		const ids = new Set(this.queue.map((s) => s.id));
		const newTracks = tracks.filter((t) => !ids.has(t.id));
		if (newTracks.length) this.queue = [...this.queue, ...newTracks];
	}

	// ── Control actions ─────────────────────────────────────────────────────

	setVolume(params: { volume: number }): void {
		this.volume = params.volume;
		this.isMuted = params.volume === 0;
	}

	toggleMute(): void {
		this.isMuted = !this.isMuted;
	}

	setPlaybackRate(rate: number): void {
		if (this.duration && this.htmlAudio.isLive(this.duration)) return;
		this.playbackRate = Math.max(0.25, Math.min(2, rate));
	}

	changeRepeatMode(): void {
		const modes: RepeatMode[] = ["none", "one", "all"];
		const i = modes.indexOf(this.repeatMode);
		this.repeatMode = modes[(i + 1) % modes.length] as RepeatMode;
	}

	setRepeatMode(mode: RepeatMode): void {
		this.repeatMode = mode;
	}
	setInsertMode(mode: InsertMode): void {
		this.insertMode = mode;
	}

	shuffle(): void {
		if (!this.queue.length || this.queue.length < 2 || !this.currentTrack) return;
		// Derive the position from the playing track so an earlier mutation cannot
		// cause the wrong entry to be excluded/duplicated by the shuffle.
		this.syncCurrentQueueIndex();
		const rest = this.queue.filter((_, i) => i !== this.currentQueueIndex);
		const shuffled = [...rest];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
		}
		this.queue = [this.currentTrack, ...shuffled];
		this.currentQueueIndex = 0;
		this.shuffleEnabled = true;
	}

	unshuffle(): void {
		this.shuffleEnabled = false;
	}

	// ── State actions ───────────────────────────────────────────────────────

	setCurrentTrack(track: Track | null): void {
		if (!track) {
			this.currentTrack = null;
			this.currentQueueIndex = -1;
			this.isPlaying = false;
			this.currentTime = 0;
			this.duration = 0;
			this.queue = [];
			this.isLoading = false;
			this.isError = false;
			this.errorMessage = null;
			return;
		}
		if (this.currentTrack?.id === track.id) return;
		this.currentTrack = track;
		this.queue = [track];
		this.currentQueueIndex = 0;
		this.isLoading = true;
		this.isPlaying = false;
		this.currentTime = 0;
		this.duration = 0;
		this.isError = false;
		this.errorMessage = null;
		this.loadAndPlayTrack(track, 0);
	}

	/** Called by AudioProvider to sync audio element time into state. */
	syncTime(currentTime: number, duration: number): void {
		this.currentTime = currentTime;
		this.duration = duration;
		this.progress = duration > 0 ? (currentTime / duration) * 100 : 0;
	}

	setError(message: string | null): void {
		this.isError = !!message;
		this.errorMessage = message;
		this.isLoading = false;
		this.isPlaying = false;
	}

	/**
	 * Sets state to signal the provider to load and play a track.
	 * The actual audio loading is handled by AudioProvider via $effect.
	 */
	loadAndPlayTrack(track: Track, queueIndex: number): void {
		const isLiveStream =
			track.live === true ||
			(track.duration !== undefined && this.htmlAudio.isLive(track.duration));

		this.currentTrack = track;
		// Keep the index and track in agreement: trust the caller's slot only when
		// it really addresses this entry, otherwise re-anchor by identity.
		const atIndex = this.queue[queueIndex];
		const indexMatches =
			atIndex !== undefined &&
			(atIndex === track ||
				(track.id !== undefined && String(atIndex.id) === String(track.id)));
		this.currentQueueIndex = indexMatches ? queueIndex : findTrackQueueIndex(this.queue, track);
		this.isError = false;
		this.errorMessage = null;

		if (isLiveStream && this.playbackRate !== 1) this.playbackRate = 1;

		// Signal provider: set isPlaying=true to trigger load+play effect
		this.isLoading = false;
		this.isBuffering = false;
		this.isPlaying = true;
	}
}

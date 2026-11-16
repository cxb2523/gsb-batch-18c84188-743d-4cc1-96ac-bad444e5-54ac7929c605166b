/**
 * Playback speed: the choices, the per-device preference and a tiny store so the full
 * player, the mini player and the audio element all follow one value.
 *
 * The preference lives in localStorage (`agk-playback-speed`) on the visitor's device. It is
 * a preference, not tracking: it never leaves the device and is not sent to analytics.
 * Tours can hide the control (`showPlaybackSpeed: false`); the app then plays at 1x whatever
 * a visitor chose in another tour. The stored choice is left untouched, so the next tour that
 * shows the control returns to it.
 */
import { useSyncExternalStore } from 'react';

export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export const DEFAULT_PLAYBACK_SPEED: PlaybackSpeed = 1;
export const PLAYBACK_SPEED_STORAGE_KEY = 'agk-playback-speed';

/** A stored value back to one of the offered speeds; anything else is the default. */
export function parsePlaybackSpeed(raw: unknown): PlaybackSpeed {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return PLAYBACK_SPEEDS.find((speed) => speed === value) ?? DEFAULT_PLAYBACK_SPEED;
}

/** The speed after `current` in the list, wrapping from the fastest to the slowest. */
export function nextPlaybackSpeed(current: PlaybackSpeed): PlaybackSpeed {
  const index = PLAYBACK_SPEEDS.indexOf(current);
  return PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length];
}

/** `1.25` -> `1.25×`, `1` -> `1×`. */
export const formatPlaybackSpeed = (speed: number): string => `${speed}×`;

/**
 * The rate the audio must actually play at. This is the one place the tour setting
 * (`showPlaybackSpeed`) and the visitor's saved choice meet: a tour that hides the control
 * always plays at 1×, and its setting must not overwrite the saved choice, so turning the
 * control back on (or opening a tour that has it) returns to the speed the visitor picked.
 */
export const effectivePlaybackSpeed = (showControl: boolean, chosen: PlaybackSpeed): PlaybackSpeed =>
  showControl ? chosen : DEFAULT_PLAYBACK_SPEED;

function readStored(): PlaybackSpeed {
  try {
    return parsePlaybackSpeed(localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY));
  } catch {
    return DEFAULT_PLAYBACK_SPEED; // storage blocked
  }
}

let current: PlaybackSpeed = readStored();
const listeners = new Set<() => void>();

export const getPlaybackSpeed = (): PlaybackSpeed => current;

export function setPlaybackSpeed(speed: PlaybackSpeed): void {
  current = parsePlaybackSpeed(speed);
  try {
    if (current === DEFAULT_PLAYBACK_SPEED) localStorage.removeItem(PLAYBACK_SPEED_STORAGE_KEY);
    else localStorage.setItem(PLAYBACK_SPEED_STORAGE_KEY, String(current));
  } catch {
    // storage blocked: the choice still holds until the page closes
  }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The visitor's chosen speed, kept in step across every component that shows or uses it. */
export const usePlaybackSpeed = (): PlaybackSpeed => useSyncExternalStore(subscribe, getPlaybackSpeed, () => DEFAULT_PLAYBACK_SPEED);

/**
 * The rate to play at, given whether the current tour shows the control. Components that
 * only display the speed still use `usePlaybackSpeed`; everything that decides what the
 * audio and the lock screen do must go through this so the three stay in step.
 */
export const useEffectivePlaybackSpeed = (showControl: boolean): PlaybackSpeed =>
  effectivePlaybackSpeed(showControl, usePlaybackSpeed());

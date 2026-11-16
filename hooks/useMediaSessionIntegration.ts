import { useCallback, useEffect, useRef } from 'react';
import { useMediaSession, useMediaMeta } from 'use-media-session';
import { AudioStop } from '../types';
import { UseAudioPlayerReturn } from './useAudioPlayer';

/**
 * Maps an artwork URL's file extension to a MIME type for MediaSession metadata.
 * Exported for unit testing.
 */
export const getArtworkType = (url: string | undefined): string | null => {
  if (!url) return null;
  const ext = url.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
};

export interface UseMediaSessionIntegrationProps {
  audioPlayer: UseAudioPlayerReturn;
  currentAudioStop: AudioStop | undefined;
  tourTitle: string | undefined;
  isPlaying: boolean;
  setIsPlaying: (value: boolean | ((prev: boolean) => boolean)) => void;
  onPreviousTrack: () => void;
  onNextTrack: () => void;
  /** Speed the audio plays at; the OS scrubber needs it to advance at the right pace. */
  playbackRate?: number;
}

/**
 * Wires the browser MediaSession API (iOS Control Center / lock-screen controls)
 * to the audio player and tour navigation. Extracted from App.tsx.
 *
 * Responsibilities:
 * - Publishes track metadata + artwork to the OS.
 * - Routes OS transport controls (play/pause/seek/prev/next) to the player.
 * - Keeps the OS position scrubber in sync (throttled to once per second).
 *
 * CRITICAL FOR iOS: play/pause callbacks set React state only AFTER the native
 * play()/pause() resolves, otherwise iOS sees a state/element mismatch and shows
 * the wrong transport button.
 */
export const useMediaSessionIntegration = ({
  audioPlayer,
  currentAudioStop,
  tourTitle,
  isPlaying,
  setIsPlaying,
  onPreviousTrack,
  onNextTrack,
  playbackRate = 1,
}: UseMediaSessionIntegrationProps): void => {
  // Build artwork array for MediaSession metadata
  const artworkType = getArtworkType(currentAudioStop?.image);
  const mediaSessionArtwork = currentAudioStop?.image
    ? [{ src: currentAudioStop.image, sizes: '512x512', type: artworkType || 'image/jpeg' }]
    : [];

  useMediaMeta({
    title: currentAudioStop?.title || '',
    artist: tourTitle || '',
    album: 'AudioGuideKit',
    artwork: mediaSessionArtwork,
  });

  // Play callback - MUST set state AFTER play succeeds (iOS requirement)
  const playTrack = useCallback(() => {
    audioPlayer.play()
      .then(() => {
        setIsPlaying(true);
      })
      .catch((e) => {
        console.error('[MediaSession] play() failed:', e);
      });
  }, [audioPlayer, setIsPlaying]);

  const pauseTrack = useCallback(() => {
    const audio = audioPlayer.audioElement;
    if (audio && !audio.paused) {
      audioPlayer.pause();
      setIsPlaying(false);
    }
  }, [audioPlayer, setIsPlaying]);

  const seekBackward = useCallback(() => {
    audioPlayer.skipBackward(10);
  }, [audioPlayer]);

  const seekForward = useCallback(() => {
    audioPlayer.skipForward(10);
  }, [audioPlayer]);

  useMediaSession({
    playbackState: isPlaying ? 'playing' : 'paused',
    onPlay: playTrack,
    onPause: pauseTrack,
    onSeekBackward: seekBackward,
    onSeekForward: seekForward,
    onPreviousTrack: onPreviousTrack,
    onNextTrack: onNextTrack,
  });

  // Update MediaSession position state. Two triggers share one reporter:
  // - a new speed is reported at once (the OS scrubber would otherwise advance at the old
  //   pace until the next whole second), and
  // - otherwise at most once per second while the position moves.
  const lastPositionUpdateRef = useRef(0);
  const lastRateRef = useRef(playbackRate);

  const reportPositionState = useCallback((rate: number) => {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return false;

    // Read the element, not React state: a speed change must be reported in the same tick,
    // before the next timeupdate has had a chance to re-render. Fall back to the state when
    // the element is between sources (its duration is NaN until the new metadata loads).
    const element = audioPlayer.audioElement;
    const elementDuration = element?.duration;
    const elementCurrentTime = element?.currentTime;
    const duration = elementDuration !== undefined && isFinite(elementDuration) ? elementDuration : audioPlayer.duration;
    const currentTime = elementCurrentTime !== undefined && isFinite(elementCurrentTime) ? elementCurrentTime : audioPlayer.currentTime;
    if (!(duration > 0) || !isFinite(duration) || !isFinite(currentTime)) return false;

    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.min(Math.max(currentTime, 0), duration),
      });
      lastPositionUpdateRef.current = Date.now();
      lastRateRef.current = rate;
      return true;
    } catch {
      return false; // Ignore errors (e.g. a duration the browser rejects)
    }
  }, [audioPlayer.audioElement, audioPlayer.currentTime, audioPlayer.duration]);

  // A new speed goes out immediately, even inside the one-second window.
  useEffect(() => {
    if (lastRateRef.current === playbackRate) return;
    reportPositionState(playbackRate);
  }, [playbackRate, reportPositionState]);

  // Periodic sync, throttled to once per second. A rate that has not reached the OS yet
  // (the immediate effect ran before the new stop's duration was known) skips the throttle.
  useEffect(() => {
    const ratePending = lastRateRef.current !== playbackRate;
    if (!ratePending && Date.now() - lastPositionUpdateRef.current < 1000) return;
    reportPositionState(playbackRate);
  }, [audioPlayer.currentTime, audioPlayer.duration, playbackRate, reportPositionState]);
};

import type { ProductionSourceAssignment, SourceDoc } from '../db/types.js';
import { assignAudioChannels } from './audio-channels.js';

/**
 * Per-guest return feed (mix-minus) topology helpers (epic #208, issue #300,
 * `docs/specs/guest-calling-intercom.md` §"Return feed design").
 *
 * A return feed is a post-fader aux bus on `builtin.mixer` with a send from
 * every audio channel. `program-minus` (default) closes the guest's own send;
 * `program` opens it. Send levels (`ch{N}_aux{M}_level`) are live so the mode
 * can change mid-show.
 *
 * PERSISTENT OWN-CHANNEL BLOCK: post-fader sends follow the channel fader, so a
 * plain zero in the initial send matrix (`ch{N}_aux{M}_level = 0`) is not
 * enough to keep a program-minus guest out of their own return — any runtime
 * path that restores a send level (unmute/fader recovery) would put the guest's
 * own voice back on the bus. Each program-minus return therefore also carries a
 * build-time block on its own channel (`ch{N}_aux{M}_blocked = true`): a
 * topology-level mask Strom enforces for the life of the flow regardless of
 * mute, fader or live send-level changes. It touches only that one channel's
 * send into that one return bus — other channels (including the other guest)
 * keep their normal post-fader sends, and the main program output is never
 * involved (no `to_main`/main-bus property is written).
 *
 * BUS-NUMBERING INVARIANT: return buses are numbered *after* the crew aux buses
 * (aux `numCrewAuxBuses + 1` … `numCrewAuxBuses + numReturns`). Crew aux buses
 * are wired into every WHEP output; return buses must be EXCLUDED from that loop
 * (a return goes to exactly one guest's WHEP output, its own single audio track),
 * so anything iterating aux buses for the WHEP fan-out must cap at
 * `numCrewAuxBuses`, never `num_aux_buses` (which now also counts return buses).
 */

export type ReturnMode = 'program' | 'program-minus';

/** Send level for an open send (unity). A closed send is 0. */
export const RETURN_SEND_OPEN = 1.0;
export const RETURN_SEND_CLOSED = 0.0;

/**
 * Build-time mixer property that hard-blocks one channel's send into one aux
 * bus (`ch{N}_aux{M}_blocked`, Strom `builtin.mixer`, `live: false`). Unlike the
 * live `ch{N}_aux{M}_level` send gain, a block is topology: the channel can
 * never reach that bus while the flow runs, no matter how its mute, fader or
 * send level moves. Applied only at flow build (flow-generator); it is never
 * written to a running pipeline.
 */
export function returnOwnChannelBlockKey(channel: number, auxBus: number): string {
  return `ch${channel + 1}_aux${auxBus}_blocked`;
}

export interface ReturnBus<S> {
  /** The assignment (guest input) this return belongs to. */
  assignment: ProductionSourceAssignment;
  /** Guest's own 0-based audio channel — the one excluded in `program-minus`. */
  ownChannel: number;
  /** 1-based aux bus index on the mixer (already offset past the crew aux buses). */
  auxBus: number;
  /** Current return mode from the assignment's `returnFeed`. */
  mode: ReturnMode;
  source: S;
}

/**
 * Numbers the return aux buses for a production's assignments. Only assignments
 * carrying a `returnFeed` get a return bus, and only ones that resolve to an
 * audio channel (an input without audio has nothing to be minus'd from). Return
 * buses are numbered after the crew aux buses in the same mixerInput order the
 * audio channels are numbered, so the mapping is stable across activations.
 *
 * @param assignments   the production's source assignments
 * @param resolve       looks up a source by id (virtual or DB)
 * @param numCrewAuxBuses number of crew aux buses (the returns start after these)
 */
export function assignReturnBuses<S>(
  assignments: readonly ProductionSourceAssignment[],
  resolve: (sourceId: string) => S | undefined,
  numCrewAuxBuses: number,
): ReturnBus<S>[] {
  const channels = assignAudioChannels(assignments, resolve);
  const channelByMixerInput = new Map(
    channels.map((c) => [c.assignment.mixerInput, c]),
  );
  const returns: ReturnBus<S>[] = [];
  for (const c of channels) {
    if (!c.assignment.returnFeed) continue;
    const found = channelByMixerInput.get(c.assignment.mixerInput);
    if (!found) continue;
    returns.push({
      assignment: c.assignment,
      ownChannel: c.channel,
      auxBus: numCrewAuxBuses + returns.length + 1,
      mode: c.assignment.returnFeed.synced,
      source: c.source,
    });
  }
  return returns;
}

/**
 * Builds the `ch{N}_aux{M}_level` send-matrix properties for a single return
 * bus. Every audio channel sends into the bus at unity, except:
 *   - the guest's own channel in `program-minus` (closed — mix-minus), and
 *   - any channel currently taken off the main program (`to_main` false), which
 *     is mirrored so a return never keeps a channel the crew removed.
 *
 * @param auxBus        1-based aux bus index of this return
 * @param ownChannel    0-based own channel to exclude in program-minus
 * @param mode          program | program-minus
 * @param numChannels   total audio channels on the mixer
 * @param toMainByChannel optional 0-based channel → to_main state; a false entry
 *                        forces that channel's send closed regardless of mode
 */
export function returnSendMatrix(
  auxBus: number,
  ownChannel: number,
  mode: ReturnMode,
  numChannels: number,
  toMainByChannel?: ReadonlyMap<number, boolean>,
): Record<string, number> {
  const props: Record<string, number> = {};
  for (let ch = 0; ch < numChannels; ch++) {
    const isOwn = ch === ownChannel;
    const closedByMode = isOwn && mode === 'program-minus';
    const offProgram = toMainByChannel ? toMainByChannel.get(ch) === false : false;
    const open = !closedByMode && !offProgram;
    props[`ch${ch + 1}_aux${auxBus}_level`] = open ? RETURN_SEND_OPEN : RETURN_SEND_CLOSED;
  }
  return props;
}

/**
 * Builds the persistent own-channel block for a single return bus: the
 * build-time `ch{N}_aux{M}_blocked` property that keeps the guest's own channel
 * off their own return for the whole life of the flow.
 *
 * Only `program-minus` returns are blocked — a `program` return's whole point is
 * that the guest hears the full program including themselves, so it gets no
 * block and returns `{}` (its send matrix already opens every channel). The
 * block is per (channel, bus): nothing here affects any other channel, any
 * other return bus, or the main program output.
 *
 * @param auxBus     1-based aux bus index of this return
 * @param ownChannel 0-based own channel that must never enter this return
 * @param mode       program | program-minus
 */
export function returnOwnChannelBlock(
  auxBus: number,
  ownChannel: number,
  mode: ReturnMode,
): Record<string, boolean> {
  if (mode !== 'program-minus') return {};
  return { [returnOwnChannelBlockKey(ownChannel, auxBus)]: true };
}

/**
 * Mirrors a set of `ch{N}_to_main` changes into the return sends. When the crew
 * mutes / audio-follow-video takes a channel off program, every return whose own
 * send policy would otherwise keep that channel open must close it in the same
 * Strom update (spec §"Mirror `to_main` into return sends"). Returns the merged
 * `ch{N}_aux{M}_level` properties to spread into the Strom block update.
 *
 * @param returns          the return buses (from `assignReturnBuses`)
 * @param toMainChanges    0-based channel → new to_main value being applied now
 */
export function mirrorToMainIntoReturns<S>(
  returns: readonly ReturnBus<S>[],
  toMainChanges: ReadonlyMap<number, boolean>,
): Record<string, number> {
  const props: Record<string, number> = {};
  for (const r of returns) {
    for (const [ch, toMain] of toMainChanges) {
      const isOwn = ch === r.ownChannel;
      const closedByMode = isOwn && r.mode === 'program-minus';
      // A channel taken off program closes; a channel put back on program reopens
      // unless the mode keeps it closed (the guest's own channel in program-minus).
      const open = toMain && !closedByMode;
      props[`ch${ch + 1}_aux${r.auxBus}_level`] = open ? RETURN_SEND_OPEN : RETURN_SEND_CLOSED;
    }
  }
  return props;
}

/** Type helper: the resolved-source shape return-bus assignment needs. */
export type ReturnSourceLike = Pick<SourceDoc, 'streamType' | 'name'>;

/** Persisted per-guest return bus (mirror of ProductionDoc.returnBuses entries). */
export interface PersistedReturnBus {
  mixerInput: string;
  auxBus: number;
  ownChannel: number;
  mode: ReturnMode;
}

/**
 * Builds the `ch{N}_aux{M}_level` mirror properties for a set of persisted return
 * buses given `ch{N}_to_main` changes the crew is applying now (mute / AFV). One
 * 0-based channel key maps to its new to_main value. A channel taken off program
 * closes in every return; a channel put back reopens unless a return keeps it
 * closed by mode (its own channel in program-minus). Spread the result into the
 * SAME Strom block update so a return never keeps a channel the crew removed.
 */
export function mirrorToMainForPersistedReturns(
  returnBuses: readonly PersistedReturnBus[],
  toMainChanges: ReadonlyMap<number, boolean>,
): Record<string, number> {
  const props: Record<string, number> = {};
  for (const rb of returnBuses) {
    for (const [ch, toMain] of toMainChanges) {
      const closedByMode = ch === rb.ownChannel && rb.mode === 'program-minus';
      const open = toMain && !closedByMode;
      props[`ch${ch + 1}_aux${rb.auxBus}_level`] = open ? RETURN_SEND_OPEN : RETURN_SEND_CLOSED;
    }
  }
  return props;
}

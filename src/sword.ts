// The sword: how long a swing takes, where through it the blade lands, and what it can reach.
//
// One clock for the blade and for the blow. The loop asks advance() for the phase it must draw and for the one
// step in which the blade lands; damage, flash, flecks and cries are resolved only in that step, so the picture
// and what happens on screen cannot drift apart.
//
// No three.js here: the geometry of the blow is plain numbers and can be tested without a renderer.

/** The blow: how far it reaches, the half-angle of the arc each side of the eye, and hearts it takes. */
export const SWORD = { reach: 2.3, arc: 0.95, damage: 1 }
/** seconds a swing takes */
export const SWING_SECONDS = 0.42
/** the share of a swing at which the blade lands */
export const STRIKE_AT = 0.3

export interface SwingStep {
  /** true in the single step in which the blade lands: resolve the blow now, and only now */
  hit: boolean
  /** how far through the swing the blade is, 0..1, or -1 between swings */
  phase: number
  /** the swing this step belongs to; 0 between swings */
  id: number
}

export interface Sword {
  /** how far through the swing the blade is, 0..1, or -1 between swings */
  readonly phase: number
  readonly swinging: boolean
  /** the id of the swing in hand, or 0 between swings */
  readonly id: number
  /** Starts a swing. False when one is under way already: a second press adds no second settlement. */
  swing(): boolean
  /** Gives up the swing in hand: nothing more is resolved from it. */
  cancel(): void
  /** Moves the blade on by dt. Returns the phase to draw and whether this is the step the blade lands in. */
  advance(dt: number): SwingStep
}

/** shortest signed angle from one heading to another, radians */
export const headingBetween = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from))

/**
 * True when a round creature stands within reach and inside the arc before the eye. The eye looks along
 * (-sin yaw, -cos yaw); the arc runs reach metres from the player and `arc` radians to each side of that line.
 */
export function inSwordArc({ x, z, yaw, reach, arc, targetX, targetZ, radius = 0 }: { x: number; z: number; yaw: number; reach: number; arc: number; targetX: number; targetZ: number; radius?: number }) {
  const dx = targetX - x
  const dz = targetZ - z
  if (Math.hypot(dx, dz) > reach + radius) return false
  return Math.abs(headingBetween(yaw, Math.atan2(-dx, -dz))) <= arc
}

export function createSword(): Sword {
  let phase = -1
  let id = 0
  // The blow of the swing in hand has been resolved: there is exactly one such step per swing.
  let struck = false

  return {
    get phase() {
      return phase
    },
    get swinging() {
      return phase >= 0
    },
    get id() {
      return phase >= 0 ? id : 0
    },
    swing() {
      if (phase >= 0) return false
      phase = 0
      id++
      struck = false
      return true
    },
    cancel() {
      phase = -1
      struck = true
    },
    advance(dt: number) {
      if (phase < 0) return { hit: false, phase: -1, id: 0 }
      const next = phase + Math.max(0, dt) / SWING_SECONDS
      // The step that reaches the landing stops on it: the blade drawn this frame is the blade that lands, even
      // if the frame was long enough to have carried it past. No step resolves a swing twice.
      if (!struck && phase < STRIKE_AT && next >= STRIKE_AT) {
        struck = true
        phase = STRIKE_AT
        return { hit: true, phase, id }
      }
      phase = next >= 1 ? -1 : next
      return { hit: false, phase, id }
    },
  }
}

// The sword clock: one swing settles its blow exactly once, at STRIKE_AT of the animation and nowhere else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STRIKE_AT, SWING_SECONDS, createSword, inSwordArc } from '../src/sword.ts'

/** run a swing at a fixed frame step and return every step that settled a blow */
function run(dt: number, seconds = SWING_SECONDS * 1.5) {
  const sword = createSword()
  sword.swing()
  const frames: { hit: boolean; phase: number; id: number; time: number }[] = []
  let time = 0
  while (time < seconds) {
    time += dt
    frames.push({ ...sword.advance(dt), time })
  }
  return { sword, frames }
}

test('a swing settles exactly one blow, whatever the frame rate', () => {
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 1 / 24]) {
    const { frames } = run(dt)
    const hits = frames.filter((frame) => frame.hit)
    assert.equal(hits.length, 1, `one blow at ${1 / dt} fps`)
    // the blade drawn in the frame that settles the blow is the blade at the landing
    assert.equal(hits[0].phase, STRIKE_AT)
    // and it was drawn there: the frame before the hit had not yet reached it
    const before = frames.slice(0, frames.indexOf(hits[0])).at(-1)!
    assert.ok(before.phase < STRIKE_AT)
  }
})

test('the blow lands at three tenths of the swing, not before or after', () => {
  const { frames } = run(1 / 60)
  const hit = frames.find((frame) => frame.hit)!
  assert.ok(hit.time >= SWING_SECONDS * STRIKE_AT)
  assert.ok(hit.time - 1 / 60 < SWING_SECONDS * STRIKE_AT)
  // the rest of the swing carries the animation on, but settles nothing
  assert.equal(frames.filter((frame) => frame.time > hit.time && frame.hit).length, 0)
  assert.ok(frames.some((frame) => frame.phase > STRIKE_AT && frame.phase <= 1), 'the swing goes on after the blow')
})

test('a second press during a swing is refused: no second settlement', () => {
  const sword = createSword()
  assert.equal(sword.swing(), true)
  sword.advance(1 / 60)
  assert.equal(sword.swing(), false)
  assert.equal(sword.swing(), false)
  let hits = 0
  for (let i = 0; i < 60; i++) if (sword.advance(1 / 60).hit) hits++
  assert.equal(hits, 1)
  assert.equal(sword.swinging, false)
})

test('after the animation has ended nothing more is settled', () => {
  const { sword, frames } = run(1 / 60, SWING_SECONDS * 3)
  assert.equal(frames.filter((frame) => frame.hit).length, 1)
  assert.equal(sword.swinging, false)
  assert.equal(sword.advance(1).hit, false)
  assert.equal(sword.phase, -1)
})

test('a new swing settles its own blow, and only its own', () => {
  const sword = createSword()
  sword.swing()
  const first: number[] = []
  while (sword.swinging) {
    const step = sword.advance(1 / 60)
    if (step.hit) first.push(step.id)
  }
  sword.swing()
  const second: number[] = []
  while (sword.swinging) {
    const step = sword.advance(1 / 60)
    if (step.hit) second.push(step.id)
  }
  assert.deepEqual(first, [1])
  assert.deepEqual(second, [2])
})

test('a long frame stops the blade on the landing and settles it once', () => {
  const sword = createSword()
  sword.swing()
  // a frame long enough to jump clean across the landing
  const step = sword.advance(SWING_SECONDS * 0.9)
  assert.equal(step.hit, true)
  assert.equal(step.phase, STRIKE_AT)
  assert.equal(sword.advance(1).hit, false)
  assert.equal(sword.swinging, false)
})

test('a cancelled swing settles nothing, and a later one still lands once', () => {
  const sword = createSword()
  sword.swing()
  sword.advance(0.1)
  sword.cancel()
  assert.equal(sword.swinging, false)
  assert.equal(sword.advance(1).hit, false)
  assert.equal(sword.swing(), true)
  assert.equal(sword.advance(1).hit, true)
})

test('the sword reaches what is inside the arc before the eye, each side of reach', () => {
  const eye = { x: 0, z: 0, yaw: 0, reach: 2.3, arc: 0.95 }
  // the eye looks along -Z
  assert.equal(inSwordArc({ ...eye, targetX: 0, targetZ: -2 }), true)
  assert.equal(inSwordArc({ ...eye, targetX: 1.2, targetZ: -1.6 }), true)
  assert.equal(inSwordArc({ ...eye, targetX: 0, targetZ: 2 }), false, 'behind the eye')
  assert.equal(inSwordArc({ ...eye, targetX: 0, targetZ: -2.8 }), false, 'past the reach')
  assert.equal(inSwordArc({ ...eye, targetX: 2.4, targetZ: -0.4 }), false, 'outside the arc')
  // a creature is a body, not a point: its radius is given to it
  assert.equal(inSwordArc({ ...eye, targetX: 0, targetZ: -2.8, radius: 0.6 }), true)
  // and turning the eye turns the arc with it
  assert.equal(inSwordArc({ ...eye, yaw: Math.PI / 2, targetX: -2, targetZ: 0 }), true)
})

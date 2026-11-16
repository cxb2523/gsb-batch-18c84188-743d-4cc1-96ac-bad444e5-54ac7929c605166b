// What one blow of the sword does to the pack: everything in the arc is struck, each one once, the dead take no part.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { buildMobs } from '../src/mobs.ts'

const build = () => buildMobs({ scene: new THREE.Scene(), colliders: [], walkable: () => true })

/** a goblin of the pack, put where the test wants it */
function place(mobs: ReturnType<typeof build>, index: number, x: number, z: number) {
  const mob = mobs.list[index]
  mob.x = x
  mob.z = z
  mob.stance = 'roam'
  mob.clock = 0
  return mob
}

const EYE = { x: 0, z: 0, yaw: 0, reach: 2.3, arc: 0.95, damage: 1 }

test('a blow through empty air strikes nothing', () => {
  const mobs = build()
  const { events, hits } = mobs.strike(EYE)
  assert.equal(hits.length, 0)
  assert.equal(events.length, 0)
})

test('a creature in the arc is struck once by one blow', () => {
  const mobs = build()
  const goblin = place(mobs, 0, 0, -1.6)
  const before = goblin.health
  const { hits, events } = mobs.strike(EYE)
  assert.equal(hits.length, 1)
  assert.equal(goblin.health, before - 1)
  assert.equal(events.filter((event) => event.type === 'hurt' || event.type === 'death').length, 1)
  // the blow is felt: it flares in that very call (its materials are lit at once) and is knocked back
  assert.ok(goblin.materials.every((material) => material.uniforms.uFlash.value.w > 0), 'flashes in the frame it is struck')
  assert.ok(Math.hypot(goblin.pushX, goblin.pushZ) > 0)
})

test('a blow through empty air leaves every creature unlit and unmoved', () => {
  const mobs = build()
  const goblin = place(mobs, 0, 0, 1.5) // behind the eye
  const pushed = Math.hypot(goblin.pushX, goblin.pushZ)
  const { hits, events } = mobs.strike(EYE)
  assert.equal(hits.length, 0)
  assert.equal(events.length, 0)
  assert.equal(goblin.flash, 0)
  assert.equal(Math.hypot(goblin.pushX, goblin.pushZ), pushed)
  assert.ok(goblin.materials.every((material) => material.uniforms.uFlash.value.w === 0))
})

test('every creature in the arc is struck in the same blow, each only once', () => {
  const mobs = build()
  const a = place(mobs, 0, -0.8, -1.8)
  const b = place(mobs, 1, 0.9, -1.7)
  const c = place(mobs, 2, 0, 1.9) // behind the eye
  const health = [a.health, b.health, c.health]
  const { hits } = mobs.strike(EYE)
  assert.equal(hits.length, 2)
  assert.deepEqual([a.health, b.health, c.health], [health[0] - 1, health[1] - 1, health[2]])
})

test('a fallen creature takes no further part in the blow', () => {
  const mobs = build()
  const goblin = place(mobs, 0, 0, -1.5)
  goblin.health = 1
  const first = mobs.strike(EYE)
  assert.deepEqual(first.hits.map((hit) => hit.dead), [true])
  assert.equal(goblin.stance, 'dead')
  const second = mobs.strike(EYE)
  assert.equal(second.hits.length, 0)
  assert.equal(goblin.health, 0, 'a dead creature is not struck again')
})

test('a blow that kills says so, and one that only hurts says that', () => {
  const mobs = build()
  const goblin = place(mobs, 0, 0, -1.5)
  goblin.health = 3
  assert.ok(mobs.strike(EYE).events.every((event) => event.type !== 'death'))
  goblin.health = 1
  assert.equal(mobs.strike(EYE).events.filter((event) => event.type === 'death').length, 1)
})

test('a struck creature calls the roaming ones near it, but not the ones far off', () => {
  const mobs = build()
  const goblin = place(mobs, 0, 0, -1.5)
  const near = place(mobs, 1, 12, -1.5)
  const far = place(mobs, 2, 60, -1.5)
  const { events } = mobs.strike(EYE)
  assert.equal(goblin.stance, 'reel')
  assert.equal(near.stance, 'chase')
  assert.equal(far.stance, 'roam')
  assert.ok(events.some((event) => event.type === 'alert'))
})

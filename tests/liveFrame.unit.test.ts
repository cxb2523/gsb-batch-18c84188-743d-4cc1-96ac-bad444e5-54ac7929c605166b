import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedLiveFrame, type LiveClip, type LiveFrame } from '../src/liveFrame.js';

function frame(): LiveFrame {
  return { generation: 1, count: 1, drawOrder: new Int32Array([0]), vertices: new Float64Array([2, 3]), tint: new Float64Array([1, 1, 1, 1]),
    attachments: Object.freeze([Object.freeze({ slot: 's', slotIndex: 0, attachment: 'named', skin: 'default', placeholder: 'p', kind: 'region' as const, region: 'r', page: 'page', pma: false, blend: 'Normal' as const, offset: 0, count: 2, uvs: Object.freeze([0, 1]), triangles: Object.freeze([0, 1, 2]), dark: null, clip: null })]) };
}

/** A zero-copy indexed view over a backing buffer, the shape `numbers()` builds. */
function liveNumbers(buffer: Float64Array): LiveClip['polygon'] {
  const view = new Array<number>(buffer.length);
  for (let i = 0; i < buffer.length; i++) Object.defineProperty(view, i, { enumerable: true, get: () => buffer[i] });
  return Object.freeze(view) as LiveClip['polygon'];
}

/** Two covered slots over one shared clip whose polygon is a live, mutable buffer. */
function clippedFrame(polygon: Float64Array): LiveFrame {
  const clip: LiveClip = { polygon: liveNumbers(polygon), inverse: false, convex: true };
  const attachment = (slot: string, index: number) => Object.freeze({ slot, slotIndex: index, attachment: 'named', skin: 'default', placeholder: 'p', kind: 'region' as const, region: 'r', page: 'page', pma: false, blend: 'Normal' as const, offset: 0, count: polygon.length, uvs: Object.freeze([0, 1]), triangles: Object.freeze([0, 1, 2]), dark: null, clip });
  return { generation: 1, count: 2, drawOrder: new Int32Array([0, 1]), vertices: polygon, tint: new Float64Array([1, 1, 1, 1, 1, 1, 1, 1]),
    attachments: Object.freeze([attachment('a', 0), attachment('b', 1)]) };
}

test('held frame and nested buffers become stale; a fresh lease reads the next generation', () => {
  let generation = 1;
  const source = frame();
  const lease = checkedLiveFrame(source, () => generation);
  const vertices = lease.vertices;
  const uv = lease.attachments[0].uvs;
  const attachment = lease.attachments[0];
  assert.equal(vertices[0], 2);
  assert.deepEqual([...lease.attachments].map(value => value.slot), ['s']);
  generation++;
  for (const read of [() => lease.count, () => vertices[0], () => uv[0], () => attachment.slot]) assert.throws(read, /LIVE_FRAME_STALE/);
  assert.equal(checkedLiveFrame(source, () => generation).vertices[1], 3);
});

test('lease rejects writes and backing-store escape routes', () => {
  const lease = checkedLiveFrame(frame(), () => 1);
  assert.throws(() => { (lease.vertices as { [i: number]: number })[0] = 8; }, /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.get(lease.vertices, 'buffer'), /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.get(lease.vertices, 'forEach')(() => undefined), /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.set(lease.attachments[0], 'slot', 'wrong'), /LIVE_FRAME_READONLY/);
  assert.throws(() => Object.preventExtensions(lease), /LIVE_FRAME_READONLY/);
});

test('unguarded borrowed source changes while detached numeric copies remain unchanged', () => {
  const source = frame();
  const before = Array.from(source.vertices);
  (source.vertices as Float64Array)[0] = 9;
  assert.equal(source.vertices[0], 9);
  assert.deepEqual(before, [2, 3]);
});

/** Copy an indexed live view into a plain array for comparisons. */
function copyNumbers(view: LiveClip['polygon']): number[] {
  const out: number[] = [];
  for (let i = 0; i < view.length; i++) out.push(view[i]);
  return out;
}

test('a clip polygon reads its live backing buffer without detaching it', () => {
  const polygon = new Float64Array([-10, -10, 10, -10, 10, 10, -10, 10]);
  const source = clippedFrame(polygon);
  const lease = checkedLiveFrame(source, () => 1);
  const first = lease.attachments[0].clip!;
  const second = lease.attachments[1].clip!;
  // The renderer tells a whole-frame clip from a local one by object identity.
  assert.equal(first, second);
  assert.deepEqual(copyNumbers(first.polygon), [...polygon]);
  // A pose advance overwrites the backing buffer in place: no new clip object,
  // no new polygon facade, but every read follows the current pose.
  polygon.set([20, 0, 40, 0, 40, 20, 20, 20]);
  assert.equal(lease.attachments[0].clip, first);
  assert.deepEqual(copyNumbers(lease.attachments[0].clip!.polygon), [20, 0, 40, 0, 40, 20, 20, 20]);
});

test('held clip objects and nested polygon views go stale with the lease', () => {
  let generation = 1;
  const lease = checkedLiveFrame(clippedFrame(new Float64Array([0, 0, 1, 0, 1, 1, 0, 1])), () => generation);
  const clip = lease.attachments[0].clip!;
  const polygon = clip.polygon;
  assert.equal(polygon[0], 0);
  generation++;
  for (const read of [() => clip.inverse, () => clip.convex, () => clip.polygon.length, () => polygon[0], () => copyNumbers(polygon)]) {
    assert.throws(read, /LIVE_FRAME_STALE/);
  }
});

test('a lease rejects writes and backing-store access through its clip polygon', () => {
  const lease = checkedLiveFrame(clippedFrame(new Float64Array([0, 0, 1, 0, 1, 1, 0, 1])), () => 1);
  const polygon = lease.attachments[0].clip!.polygon;
  assert.throws(() => { (polygon as { [i: number]: number })[0] = 9; }, /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.get(polygon, 'buffer'), /LIVE_FRAME_READONLY/);
  assert.throws(() => (polygon as unknown as { set: (...args: unknown[]) => void }).set([1]), /LIVE_FRAME_READONLY/);
  assert.throws(() => (polygon as unknown as { fill: (...args: unknown[]) => void }).fill(1), /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.set(lease.attachments[0].clip!, 'inverse', true), /LIVE_FRAME_READONLY/);
});

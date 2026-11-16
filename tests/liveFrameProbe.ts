import { CanvasRenderer, DomRenderer, loadModel, RigPlayer, type PosedFrame } from '../src/index';

export function mismatch(a: unknown, b: unknown, path = 'frame'): string | null {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) ? null : `${path}: ${a} != ${b}`;
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${path}: ${String(a)} != ${String(b)}`;
  const left = Object.keys(a), right = Object.keys(b);
  if (left.length !== right.length || left.some(key => !right.includes(key))) return `${path}: different keys`;
  for (const key of left) {
    const found = mismatch((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function pixels(player: RigPlayer): Uint8ClampedArray {
  const renderer = player.renderer as CanvasRenderer;
  const canvas = renderer.canvas;
  const copy = document.createElement('canvas');
  copy.width = canvas.width; copy.height = canvas.height;
  const ctx = copy.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, copy.width, copy.height).data;
}

export async function liveFrameProbe(rig: string, mutant: 'none' | 'vertices' | 'snapshot' | 'lease' = 'none') {
  const assets = await loadModel({ modelUrl: `/rigs/${rig}/skeleton.model.json` });
  const rows: Array<{ animation: string; poser: string; frames: number; numeric: string[]; pixelDifferences: number; pixelValues: number; contentPixels: number; snapshotKept: boolean; stale: boolean; nestedStale: boolean; rendererStale: boolean; readonly: boolean; drawIdentity: boolean | null }> = [];
  try {
    for (const animation of assets.animations) {
      const roots = [document.createElement('div'), document.createElement('div')];
      roots.forEach(root => document.body.append(root));
      const runtime = new RigPlayer(roots[0], assets, { mode: 'canvas', liveFrameChecks: mutant !== 'lease' });
      const oracle = new RigPlayer(roots[1], assets, { mode: 'canvas', poser: 'oracle' });
      try {
        runtime.play(animation.name); oracle.play(animation.name);
        if (mutant === 'snapshot' && runtime.poser === 'runtime') {
          runtime.posedFrame = () => (Reflect.get(runtime, 'runtimeFrames') as { renderFrame: PosedFrame }).renderFrame;
        }
        const numeric: string[] = [];
        let pixelDifferences = 0, pixelValues = 0, contentPixels = 0;
        let stale = false, nestedStale = false, rendererStale = false, readonly = false;
        let drawIdentity: boolean | null = null;
        const held = runtime.posedFrame();
        const kept = JSON.stringify(held);
        let count = 0;
        for (const step of [0, 0.125, 0.375, 0.75]) {
          const lease = runtime.liveFrame();
          const nested = lease.vertices;
          runtime.advance(step); oracle.advance(step);
          if (step > 0) {
            try { void lease.count; } catch (error) { stale = String(error).includes('LIVE_FRAME_STALE'); }
            try { void nested.length; } catch (error) { nestedStale = String(error).includes('LIVE_FRAME_STALE'); }
            try { runtime.renderer.render(lease); } catch (error) { rendererStale = String(error).includes('LIVE_FRAME_STALE'); }
          }
          if (mutant === 'vertices' && runtime.poser === 'runtime') {
            const raw = (Reflect.get(runtime, 'runtimeFrames') as { pose: { vertices: Float64Array } }).pose.vertices;
            for (let i = 0; i < raw.length; i += 2) Reflect.set(raw, String(i), raw[i] + 20);
          }
          const a = runtime.posedFrame(), b = oracle.posedFrame();
          const difference = mismatch(a, b);
          if (difference) numeric.push(difference);
          const identityDifference = mismatch(runtime.slotIdentity(), oracle.slotIdentity(), 'identity');
          if (identityDifference) numeric.push(identityDifference);
          const view = runtime.liveFrame();
          if (view.count !== a.order.length) numeric.push(`live count ${view.count} != snapshot ${a.order.length}`);
          for (let i = 0; i < view.count; i++) {
            const attachment = view.attachments[view.drawOrder[i]];
            const slot = a.order[i];
            if (attachment.slot !== slot.slot) numeric.push(`live slot ${attachment.slot} != snapshot ${slot.slot}`);
            const points = slot.kind === 'region' ? slot.corners : slot.vertices;
            for (let c = 0; c < points.length; c++) if (!Object.is(view.vertices[attachment.offset + c], points[c])) numeric.push(`live vertex ${attachment.slot}[${c}] differs`);
            for (let c = 0; c < 4; c++) if (!Object.is(view.tint[attachment.slotIndex * 4 + c], slot.tint[c])) numeric.push(`live tint ${attachment.slot}[${c}] differs`);
            const darkDifference = mismatch(attachment.dark, slot.dark ?? null, `live dark ${slot.slot}`);
            if (darkDifference) numeric.push(darkDifference);
            const clipDifference = mismatch(attachment.clip, slot.clip ?? null, `live clip ${slot.slot}`);
            if (clipDifference) numeric.push(clipDifference);
            const expected = b.order[i];
            if (expected) {
              const oracleDark = mismatch(attachment.dark, expected.dark ?? null, `oracle live dark ${slot.slot}`);
              if (oracleDark) numeric.push(oracleDark);
              const oracleClip = mismatch(attachment.clip, expected.clip ?? null, `oracle live clip ${slot.slot}`);
              if (oracleClip) numeric.push(oracleClip);
            }
            for (let j = 0; j < i; j++) {
              const previous = a.order[j], previousAttachment = view.attachments[view.drawOrder[j]];
              if (slot.clip && slot.clip === previous.clip && attachment.clip !== previousAttachment.clip) numeric.push(`live shared clip ${slot.slot} differs`);
            }
          }
          try { Reflect.set(view.vertices, '0', 123); } catch (error) { readonly = String(error).includes('LIVE_FRAME_READONLY'); }
          const bounds = oracle.bounds();
          if (bounds) {
            const viewport = { x: Math.floor(bounds.x) - 2, y: Math.floor(bounds.y) - 2, width: Math.ceil(bounds.width) + 5, height: Math.ceil(bounds.height) + 5 };
            (runtime.renderer as CanvasRenderer).viewport = viewport;
            (oracle.renderer as CanvasRenderer).viewport = viewport;
            runtime.draw(); oracle.draw();
            const pa = pixels(runtime), pb = pixels(oracle);
            if (pa.length !== pb.length) numeric.push('pixel dimensions differ');
            else { pixelValues += pa.length; for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) pixelDifferences++; for (let i = 3; i < pb.length; i += 4) if (pb[i] > 0) contentPixels++; }
          }
          count++;
        }
        if (runtime.poser === 'runtime') {
          const productionRoot = document.createElement('div'); document.body.append(productionRoot);
          const production = new RigPlayer(productionRoot, assets, { mode: 'canvas', liveFrameChecks: false });
          try {
            production.play(animation.name);
            const before = production.liveFrame();
            const vertices = before.vertices, tint = before.tint, order = before.drawOrder, attachments = before.attachments;
            production.advance(0.1);
            const after = production.liveFrame();
            drawIdentity = before === after && vertices === after.vertices && tint === after.tint && order === after.drawOrder && attachments === after.attachments;
          } finally { production.dispose(); productionRoot.remove(); }
        } else drawIdentity = null; // Not measurable on the oracle fallback.
        rows.push({ animation: animation.name, poser: runtime.poser, frames: count, numeric, pixelDifferences, pixelValues, contentPixels, snapshotKept: JSON.stringify(held) === kept, stale, nestedStale, rendererStale, readonly, drawIdentity });
      } finally { runtime.dispose(); oracle.dispose(); roots.forEach(root => root.remove()); }
    }
    return { rig, rows };
  } finally { assets.dispose(); }
}

/** Dynamic metadata stays borrowed in live views and detached in snapshots. */
export async function runtimeMetadataProbe() {
  const results = [];
  for (const [rig, animation] of [['figure', 'tilted_moved'], ['duo', 'shift'], ['draw', 'reorder'], ['topology', 'swap']]) {
    const assets = await loadModel({ modelUrl: `/rigs/${rig}/skeleton.model.json` });
    const roots = [document.createElement('div'), document.createElement('div')];
    const players = [new RigPlayer(roots[0], assets, { liveFrameChecks: true }), new RigPlayer(roots[1], assets, { poser: 'oracle' })];
    try {
      players.forEach(player => player.play(animation));
      players.forEach(player => player.advance(.125));
      const snapshot = players[0].posedFrame(), kept = JSON.stringify(snapshot);
      const live = players[0].liveFrame();
      const clip = live.attachments[live.drawOrder[0]]?.clip;
      const polygon = clip?.polygon;
      const clips = snapshot.order.filter(slot => slot.clip).map(slot => slot.clip!);
      const shared = clips.length > 1 ? clips.every(value => value === clips[0]) : null;
      const filtered = players.map(player => player.posedFrame(slot => slot !== 'clip'));
      const filterDifference = mismatch(filtered[0], filtered[1]);
      const afterFilterDifference = mismatch(players[0].posedFrame(), players[1].posedFrame());
      let readonly = polygon === undefined;
      if (polygon) try { Reflect.set(polygon, '0', 10); } catch (error) { readonly = String(error).includes('LIVE_FRAME_READONLY'); }
      players.forEach(player => player.advance(.375));
      let nestedStale = polygon === undefined;
      if (polygon) try { void polygon[0]; } catch (error) { nestedStale = String(error).includes('LIVE_FRAME_STALE'); }
      results.push({ rig, poser: players[0].poser, shared, readonly, nestedStale,
        snapshotKept: kept === JSON.stringify(snapshot), filterDifference, afterFilterDifference,
        difference: mismatch(players[0].posedFrame(), players[1].posedFrame()) });
    } finally { players.forEach(player => player.dispose()); assets.dispose(); }
  }
  return results;
}

/** Physics keeps the existing clock, clamp, replay and movement path by name. */
export async function runtimePhysicsPolicyProbe() {
  const assets = await loadModel({ modelUrl: '/rigs/cloth/skeleton.model.json' });
  const roots = [document.createElement('div'), document.createElement('div')];
  const players = [new RigPlayer(roots[0], assets), new RigPlayer(roots[1], assets, { poser: 'oracle' })];
  try {
    const rows: Array<{ operation: string; poser: string; difference: string | null; timeDifference: string | null }> = [];
    const record = (operation: string) => rows.push({ operation, poser: players[0].poser,
      difference: mismatch(players[0].posedFrame(), players[1].posedFrame()),
      timeDifference: mismatch(players[0].time, players[1].time) });
    for (const player of players) { player.timeScale = .5; player.play('hang', { loop: false }); }
    record('play nonloop');
    for (const dt of [.125, .375, 8]) { players.forEach(player => player.advance(dt)); record(`advance ${dt}`); }
    players.forEach(player => player.seek(.25)); record('seek backward');
    players.forEach(player => { player.moved({ x: 3, y: 1, rotation: 2 }); player.advance(1 / 60); }); record('moved');
    players.forEach(player => { player.skin = 'default'; player.advance(.125); }); record('skin replay');
    return rows;
  } finally { players.forEach(player => player.dispose()); assets.dispose(); }
}

/** The live adapter's changing clip must not invalidate a stationary mesh. */
export async function runtimeClipRendererProbe() {
  const assets = await loadModel({ modelUrl: '/rigs/figure/skeleton.model.json' });
  const root = document.createElement('div');
  root.style.clipPath = 'inset(0px)';
  document.body.append(root);
  const player = new RigPlayer(root, assets);
  const renderer = player.renderer as DomRenderer;
  const rows = [];
  try {
    for (const animation of ['tilted', 'tilted', 'tilted_moved', 'inverse', 'bare']) {
      player.play(animation, { loop: false });
      player.draw();
      rows.push({ animation, poser: player.poser, meshes: renderer.meshCount, reused: renderer.meshReuseCount,
        clipCount: renderer.clipCount, clipWrites: renderer.clipWriteCount, rootClip: root.style.clipPath,
        elementPaths: [...root.querySelectorAll<HTMLElement>('img,canvas')].map(element => element.style.clipPath),
        frameHasClip: player.posedFrame().order.some(slot => slot.clip !== undefined) });
    }
    return rows;
  } finally { player.dispose(); root.remove(); assets.dispose(); }
}

export async function liveFrameTransitions() {
  const assets = await loadModel({ modelUrl: '/rigs/turned/skeleton.model.json' });
  const root = document.createElement('div'); document.body.append(root);
  const runtime = new RigPlayer(root, assets, { mode: 'canvas', liveFrameChecks: true });
  try {
    const name = assets.animations[0].name;
    runtime.play(name);
    runtime.advance(0.35);
    const before = runtime.posedFrame();
    const live = runtime.liveFrame();
    const at = runtime.time;
    runtime.setAlpha(0, 0.5);
    const composedReason = runtime.poser;
    let oldStale = false;
    try { void live.count; } catch (error) { oldStale = String(error).includes('LIVE_FRAME_STALE'); }
    const composedTime = runtime.time;
    runtime.dispose();
    let disposed = false;
    try { runtime.liveFrame(); } catch (error) { disposed = String(error).includes('LIVE_FRAME_DISPOSED'); }
    return { beforeCount: before.order.length, at, composedTime, composedReason, oldStale, disposed };
  } finally { runtime.dispose(); root.remove(); assets.dispose(); }
}

/** Identity control: the test route supplies a null-keyed slot with no setup attachment. */
export async function liveFrameNullIdentity(plantOldCheck = false) {
  const assets = await loadModel({ modelUrl: '/rigs/turned/skeleton.model.json' });
  const roots = [document.createElement('div'), document.createElement('div')];
  roots.forEach(root => document.body.append(root));
  const runtime = new RigPlayer(roots[0], assets, { liveFrameChecks: true });
  const oracle = new RigPlayer(roots[1], assets, { poser: 'oracle' });
  try {
    runtime.play(assets.animations[0].name); oracle.play(assets.animations[0].name);
    if (plantOldCheck) Reflect.set(runtime, 'isSlotKeyedNullByTimeline', () => false);
    const rows = [];
    for (const time of [0, 0.125, 0.25, 0.5, 1.25]) {
      runtime.seek(time); oracle.seek(time);
      const actual = runtime.slotIdentity(), expected = oracle.slotIdentity();
      rows.push({ time, poser: runtime.poser, actual: actual.slots.find(slot => slot.slot === 's')?.reason,
        expected: expected.slots.find(slot => slot.slot === 's')?.reason, difference: mismatch(actual, expected, 'identity') });
    }
    return rows;
  } finally { runtime.dispose(); oracle.dispose(); assets.dispose(); roots.forEach(root => root.remove()); }
}

export interface LiveClipProbeRow {
  time: number;
  /** Every live clip polygon, flat, per covered slot. */
  livePolygons: number[][];
  /** The snapshot frame's clip polygons for the same slots. */
  snapshotPolygons: number[][];
  /** The oracle poser's snapshot polygons — the independent reference. */
  oraclePolygons: number[][];
  /** Live equals the runtime snapshot, number for number. */
  matchesSnapshot: boolean;
  /** Runtime snapshot equals the oracle snapshot, number for number. */
  matchesOracle: boolean;
  /** Every covered slot in the live view borrowed one shared clip object. */
  sharedClip: boolean;
  /** Within one lease, every covered slot also shares the polygon facade. */
  sharedPolygon: boolean;
  /** Flags travel with the clip. */
  inverse: boolean;
  convex: boolean;
}

/**
 * The clipmove rig's only motion is its clipping bone: the art never moves, so
 * any live/snapshot clip difference is the clip polygon failing to follow the
 * pose. Drives both posers plus a production (unchecked) player for the reuse
 * guarantees, and a checked player for the lease semantics.
 */
export async function liveFrameClipProbe() {
  const assets = await loadModel({ modelUrl: '/rigs/clipmove/skeleton.model.json' });
  const roots = [document.createElement('div'), document.createElement('div'), document.createElement('div')];
  roots.forEach(root => document.body.append(root));
  const checked = new RigPlayer(roots[0], assets, { liveFrameChecks: true });
  const oracle = new RigPlayer(roots[1], assets, { poser: 'oracle' });
  const production = new RigPlayer(roots[2], assets, { liveFrameChecks: false });
  const times = [0, 0.25, 0.5, 0.75];
  const rows: LiveClipProbeRow[] = [];
  const leaseChecks = { nestedStale: false, frameStale: false, readonly: false, bufferReadonly: false };
  let frameReused = true;
  let clipObjectReused = true;
  try {
    checked.play('move', { loop: false });
    oracle.play('move', { loop: false });
    production.play('move', { loop: false });
    if (checked.poser !== 'runtime') throw new Error(`clipmove must pose on the runtime, got ${checked.poser}`);

    // Hold a deep lease across the first advance: every field, the clip object
    // and its nested polygon included, must read as stale afterwards.
    const held = checked.liveFrame();
    const heldClip = held.attachments[held.drawOrder[0]].clip!;
    const heldPolygon = heldClip.polygon;

    let previousProductionFrame: object | null = null;
    let previousProductionClip: object | null = null;
    let previous = 0;
    const same = (a: number[][], b: number[][]) => a.length === b.length
      && a.every((polygon, i) => polygon.length === b[i].length && polygon.every((value, k) => Object.is(value, b[i][k])));
    for (const time of times) {
      if (time > previous) {
        checked.advance(time - previous);
        oracle.advance(time - previous);
        production.advance(time - previous);
      }
      previous = time;

      const live = checked.liveFrame();
      const snapshot = checked.posedFrame();
      const oracleFrame = oracle.posedFrame();
      const livePolygons: number[][] = [];
      const snapshotPolygons: number[][] = [];
      const oraclePolygons: number[][] = [];
      const seenClips = new Set<unknown>();
      const seenPolygons = new Set<unknown>();
      let inverse = false, convex = false;
      for (let i = 0; i < live.count; i++) {
        const attachment = live.attachments[live.drawOrder[i]];
        if (!attachment.clip) continue;
        seenClips.add(attachment.clip);
        seenPolygons.add(attachment.clip.polygon);
        inverse = attachment.clip.inverse;
        convex = attachment.clip.convex;
        livePolygons.push(Array.from(attachment.clip.polygon));
      }
      for (const slot of snapshot.order) if (slot.clip) snapshotPolygons.push(Array.from(slot.clip.polygon));
      for (const slot of oracleFrame.order) if (slot.clip) oraclePolygons.push(Array.from(slot.clip.polygon));
      rows.push({
        time, livePolygons, snapshotPolygons, oraclePolygons,
        matchesSnapshot: same(livePolygons, snapshotPolygons),
        matchesOracle: same(snapshotPolygons, oraclePolygons),
        sharedClip: seenClips.size === 1 && livePolygons.length > 1,
        sharedPolygon: seenPolygons.size === 1 && livePolygons.length > 1,
        inverse, convex,
      });

      const productionFrame = production.liveFrame();
      const productionClip = productionFrame.attachments[productionFrame.drawOrder[0]].clip;
      if (previousProductionFrame !== null && productionFrame !== previousProductionFrame) frameReused = false;
      if (previousProductionClip !== null && productionClip !== previousProductionClip) clipObjectReused = false;
      previousProductionFrame = productionFrame;
      previousProductionClip = productionClip;
    }

    checked.advance(0.2);
    try { void held.count; } catch (error) { leaseChecks.frameStale = String(error).includes('LIVE_FRAME_STALE'); }
    try { void heldPolygon[0]; } catch (error) { leaseChecks.nestedStale = String(error).includes('LIVE_FRAME_STALE'); }
    try { void heldClip.inverse; } catch (error) { leaseChecks.nestedStale &&= String(error).includes('LIVE_FRAME_STALE'); }

    const fresh = checked.liveFrame();
    const freshClip = fresh.attachments[fresh.drawOrder[0]].clip!;
    // Within one lease the polygon facade is the same object on every read.
    const facadeStable = freshClip.polygon === freshClip.polygon
      && fresh.attachments[fresh.drawOrder[1]].clip!.polygon === freshClip.polygon;
    const freshPolygon = freshClip.polygon;
    try { Reflect.set(freshPolygon, '0', 123); } catch (error) { leaseChecks.readonly = String(error).includes('LIVE_FRAME_READONLY'); }
    try { Reflect.get(freshPolygon, 'buffer'); } catch (error) { leaseChecks.bufferReadonly = String(error).includes('LIVE_FRAME_READONLY'); }

    // The moving polygon really moved: every sampled row differs from the setup row.
    const moved = rows.slice(1).some(row => !same(row.livePolygons, rows[0].livePolygons));
    return { rows, leaseChecks, frameReused, clipObjectReused, facadeStable, moved, rig: 'clipmove', poser: checked.poser };
  } finally {
    checked.dispose(); oracle.dispose(); production.dispose();
    roots.forEach(root => root.remove());
    assets.dispose();
  }
}

/**
 * Persistent own-channel block on guest return buses (mix-minus that survives a
 * runtime unmute / fader restore).
 *
 * The build-time half is covered in flow-generator-returns.test.ts: the mixer is
 * created with `ch{N}_aux{M}_blocked = true` on each program-minus guest's own
 * channel/bus pair. This file covers the RUNTIME half with the real controller
 * plugin on a listening Fastify server and a throwaway Strom:
 *
 *   - muting a guest channel and unmuting it again never opens that guest's own
 *     send on their own return bus (the to_main mirror keeps it at zero, and the
 *     build-time block is what guarantees it even if a live level write is lost);
 *   - the OTHER guest's return bus keeps carrying the channel as normal;
 *   - the program main output (`ch{N}_to_main`) is the only program-chain key
 *     touched — the block never writes a main/mute/fader property.
 *
 * CouchDB and the flow generator are mocked; the Strom mixer is a small HTTP
 * double that records every block-property PATCH.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';

const docs = new Map<string, Record<string, unknown>>();
const mockGet = vi.fn(async (id: string) => {
  const doc = docs.get(id);
  if (!doc) throw Object.assign(new Error('not found'), { statusCode: 404 });
  return doc;
});

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: vi.fn().mockResolvedValue({ ok: true }), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet, insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getOutputsDb: () => ({ get: mockGet, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/meter-relay.js', () => ({
  startMeterRelay: vi.fn(),
  stopMeterRelay: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Throwaway Strom: records every block-property PATCH, keeps its own view.
// ---------------------------------------------------------------------------

const FLOW_ID = 'flow-return-block';
const AUDIO_BLOCK = 'mixer1';

/** Strom's mixer view. The `_blocked` flags are build-time: Strom holds them and
 *  never lets a live PATCH change them (they model `live: false` topology). */
let stromProps: Record<string, unknown> = {};
const patches: Array<Record<string, unknown>> = [];

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as { properties?: Record<string, unknown> }) : {};
    const url = req.url ?? '';
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.method === 'GET' && url === `/api/flows/${FLOW_ID}`) {
      return send(200, {
        flow: {
          id: FLOW_ID,
          blocks: [{ id: AUDIO_BLOCK, block_definition_id: 'builtin.mixer', properties: { num_channels: 3 } }],
        },
      });
    }
    const blockProps = `/api/flows/${FLOW_ID}/blocks/${AUDIO_BLOCK}/properties`;
    if (req.method === 'GET' && url === blockProps) {
      return send(200, { block_id: AUDIO_BLOCK, properties: { ...stromProps }, rejected: {} });
    }
    if (req.method === 'PATCH' && url === blockProps) {
      const written = body.properties ?? {};
      patches.push(written);
      // Build-time topology keys are not live: Strom ignores any attempt to move
      // them at runtime and would reject them on a real server. Mirror that by
      // never applying `_blocked` writes here, while ordinary live keys apply.
      for (const [key, value] of Object.entries(written)) {
        if (!key.endsWith('_blocked')) stromProps[key] = value;
      }
      return send(200, { block_id: AUDIO_BLOCK, properties: { ...stromProps }, rejected: {} });
    }
    send(200, {});
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
const STROM_URL = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
process.env['STROM_URL'] = STROM_URL;

const { buildServer } = await import('../server.js');

let app: FastifyInstance;
let prodSeq = 0;

beforeAll(async () => {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  stromServer.close();
});

beforeEach(() => {
  patches.length = 0;
  // The mixer as flow-generator built it for this production: 3 channels, two
  // guest return buses (aux3 = guest on ch2, aux4 = guest on ch3) behind two
  // crew aux buses (aux1, aux2). Both returns are program-minus, so each own
  // channel carries its persistent block; send matrices start with own = 0.
  stromProps = {
    num_channels: 3,
    // guest 1 (1-based ch2) own return aux3
    ch2_aux3_level: 0,
    ch2_aux3_blocked: true,
    ch1_aux3_level: 1,
    ch3_aux3_level: 1,
    // guest 2 (1-based ch3) own return aux4
    ch3_aux4_level: 0,
    ch3_aux4_blocked: true,
    ch1_aux4_level: 1,
    ch2_aux4_level: 1,
  };
});

function newProduction(): string {
  const id = `prod-return-block-${++prodSeq}`;
  docs.set(id, {
    _id: id,
    _rev: '1-abc',
    type: 'production',
    name: 'Return block',
    status: 'active',
    stromFlowId: FLOW_ID,
    audioMixerBlockId: AUDIO_BLOCK,
    sources: [
      { sourceId: 'src-crew', mixerInput: 'video_in_1' },
      { sourceId: 'src-guest-1', mixerInput: 'video_in_2', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'src-guest-2', mixerInput: 'video_in_3', returnFeed: { synced: 'program-minus' } },
    ],
    returnBuses: [
      { mixerInput: 'video_in_2', auxBus: 3, ownChannel: 1, mode: 'program-minus' },
      { mixerInput: 'video_in_3', auxBus: 4, ownChannel: 2, mode: 'program-minus' },
    ],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  return id;
}

type Frame = Record<string, unknown>;

interface Client {
  ws: WebSocket;
  frames: Frame[];
  send: (msg: Frame) => void;
  close: () => void;
}

async function connect(productionId: string): Promise<Client> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller`);
  const frames: Frame[] = [];
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString()) as Frame); } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => resolve());
  });
  await waitFor(() => frames.some((f) => f.type === 'AUDIO_STATE' && f.elementId === 'ch3' && f.property === 'mute'));
  return { ws, frames, send: (msg) => ws.send(JSON.stringify(msg)), close: () => ws.close() };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/** Every value written for one mixer key across the recorded PATCHes. */
function writesFor(key: string): unknown[] {
  return patches.filter((p) => key in p).map((p) => p[key]);
}

describe('guest return — persistent own-channel block across mute/unmute', () => {
  it('muting then unmuting guest 1 never reopens their own return, but the other return and program keep them', async () => {
    const prod = newProduction();
    const a = await connect(prod);

    // --- Mute guest 1 (1-based ch2): to_main off, mirrored into every return. ---
    a.send({ type: 'AUDIO_SET', elementId: 'ch2', property: 'mute', value: true });
    await waitFor(() => writesFor('ch2_to_main').includes(false));
    await settle();

    // Program main output follows the mute (the audience path is driven normally).
    expect(writesFor('ch2_to_main').at(-1)).toBe(false);
    // Both returns close the just-muted channel.
    expect(writesFor('ch2_aux3_level').at(-1)).toBe(0); // guest 1's OWN return
    expect(writesFor('ch2_aux4_level').at(-1)).toBe(0); // guest 2's return

    // --- Unmute guest 1: program restores; only the own-minus return stays shut. ---
    a.send({ type: 'AUDIO_SET', elementId: 'ch2', property: 'mute', value: false });
    await waitFor(() => writesFor('ch2_to_main').includes(true));
    await settle();

    // Main output is live again.
    expect(writesFor('ch2_to_main').at(-1)).toBe(true);
    // Guest 2's return reopens the channel (post-fader, normal send).
    expect(writesFor('ch2_aux4_level').at(-1)).toBe(1);
    // Guest 1's OWN return stays closed: the mirror never reopens a program-minus
    // own channel, and the build-time block keeps it closed regardless.
    expect(writesFor('ch2_aux3_level').at(-1)).toBe(0);
    expect(stromProps['ch2_aux3_level']).toBe(0);
    expect(stromProps['ch2_aux3_blocked']).toBe(true);

    a.close();
  });

  it('the block is scoped per bus: guest 2 muting only constrains guest 2 own return', async () => {
    const prod = newProduction();
    const a = await connect(prod);

    a.send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true });
    await waitFor(() => writesFor('ch3_to_main').includes(false));
    a.send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: false });
    await waitFor(() => writesFor('ch3_to_main').includes(true));
    await settle();

    // Guest 2's own return (aux4) never reopens; guest 1's return (aux3) does.
    expect(writesFor('ch3_aux4_level').at(-1)).toBe(0);
    expect(stromProps['ch3_aux4_blocked']).toBe(true);
    expect(writesFor('ch3_aux3_level').at(-1)).toBe(1);
    expect(stromProps['ch3_aux3_blocked']).toBeUndefined();

    a.close();
  });

  it('never writes a block/main-chain property from the runtime mute path', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    // Ignore the connect-time channel reset (it legitimately seeds faders/mutes);
    // only patches produced by the mute toggles below are in scope.
    const patchesAtConnect = patches.length;

    a.send({ type: 'AUDIO_SET', elementId: 'ch2', property: 'mute', value: true });
    await waitFor(() => writesFor('ch2_to_main').includes(false));
    a.send({ type: 'AUDIO_SET', elementId: 'ch2', property: 'mute', value: false });
    await waitFor(() => writesFor('ch2_to_main').includes(true));
    await settle();

    for (const patch of patches.slice(patchesAtConnect)) {
      for (const key of Object.keys(patch)) {
        // The mute path writes only routing (`to_main`) and live aux send levels.
        expect(key.endsWith('_blocked')).toBe(false);
        expect(key).not.toBe('main_mute');
        expect(key).not.toBe('main_fader');
        expect(key).not.toMatch(/^ch\d+_fader$/);
      }
    }
    // The build-time blocks remain exactly as activation left them.
    expect(stromProps['ch2_aux3_blocked']).toBe(true);
    expect(stromProps['ch3_aux4_blocked']).toBe(true);

    a.close();
  });

  it('a fader move on a blocked own channel cannot open the return (block is topology, not level)', async () => {
    const prod = newProduction();
    const a = await connect(prod);

    // Push the guest's own fader back up. Post-fader sends would otherwise rise;
    // the block is independent of the fader.
    a.send({ type: 'AUDIO_SET', elementId: 'ch2', property: 'volume', value: 0.9 });
    await waitFor(() => writesFor('ch2_fader').includes(0.9));
    await settle(150);

    // The fader write carries NO aux keys at all — the block is untouched and the
    // own return send remains closed (both its level and its topology).
    expect(stromProps['ch2_fader']).toBe(0.9);
    expect(stromProps['ch2_aux3_level']).toBe(0);
    expect(stromProps['ch2_aux3_blocked']).toBe(true);
    // The other guest's return still receives this channel at unity.
    expect(stromProps['ch2_aux4_level']).toBe(1);

    a.close();
  });
});

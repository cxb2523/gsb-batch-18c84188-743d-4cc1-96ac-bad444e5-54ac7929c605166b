/**
 * What the driver does when its queues and OPL channels run out: a refused request has to say so and leave
 * the requests already waiting alone, a request with nowhere to play waits for a later tick, and an engine
 * note is one slot per car that also gives its channel back when the car stops.
 *
 * These build a small stand-in for DRIVER1.BIN rather than reading the game folder, so they run everywhere.
 * The bank holds ten sequences: sounds 1..8 wait a long time before their end, sound 9 ends soon after it
 * starts and sound 10 outlasts the tick it starts on. The engine records are the ones the real driver
 * carries (re/notes/90-sound.md).
 */
import { describe, it, expect } from 'vitest';
import { SoundDriver } from '../../src/engine/sound/driver';

const SIZE = 0x3000;
const BANK = 0x1400;
const INSTRUMENTS = 0x2000;
const EFFECT_QUEUE = 0x13D1;
const MUSIC_QUEUE = 0x13D9;
const SLOTS = 0x1271;
const SLOT_LEN = 0x16;
const SLOT_COUNT = 16;

const word = (d: Uint8Array, at: number, v: number): void => { d[at] = v & 0xFF; d[at + 1] = (v >> 8) & 0xFF; };

/** A driver image with ten effects and two engine records, and the tables they need to make a sound. */
function image(): Uint8Array {
  const d = new Uint8Array(SIZE);
  const sequences = [
    [0xFF, 0x05, 0x91],                        // sounds 1..8: a long wait, then the end
    [0x02, 0x91],                              // sound 9: ends a couple of ticks after it starts
    [0xFF, 0x05, 0x91],                        // sound 10: outlasts the tick it starts on
  ];
  const offsets: number[] = [];
  let at = BANK + 1 + 10 * 2;
  for (const seq of sequences) {
    offsets.push(at - BANK);
    d.set(seq, at);
    at += seq.length;
  }
  d[BANK] = 10;
  for (let i = 0; i < 10; i++) word(d, BANK + 1 + i * 2, offsets[i < 8 ? 0 : i === 8 ? 1 : 2]!);

  word(d, 0x13F2, BANK);                        // [13f2] -> the bank
  word(d, 0x13F4, INSTRUMENTS);                 // [13f4] -> the note table and the instrument records
  // the silence list at 0x104a is already a 0000 word: the reset has nothing to silence

  // fn 7b46's record: instrument 0x70, a loop point, one note and the pitch bend the game rewrites
  for (let car = 0; car < 2; car++) {
    d.set([0x00, 0x92, 0x70, 0x00, 0x9C, 0x00, 0x23, 0x7F, 0x01, 0x95, 0x00, 0x00, 0x98], 0x0008 + car * 0x10);
  }
  return d;
}

class Log {
  readonly writes: [number, number][] = [];
  write(reg: number, value: number): void { this.writes.push([reg, value]); }
}

function boot(): { d: SoundDriver; log: Log } {
  const log = new Log();
  const d = new SoundDriver(image(), log);
  d.init();
  d.setTempo(12431);                             // about one effect sequencer tick per game tick
  log.writes.length = 0;
  return { d, log };
}

/** The eight slots of one queue, as the driver would have them in its work area. */
const queue = (d: SoundDriver, at = EFFECT_QUEUE): number[] => Array.from(d.saveState(at, 8));

/** The channel records in use, with the sound number each one is playing. */
function busy(d: SoundDriver): { sound: number; state: number }[] {
  const s = d.saveState(SLOTS, SLOT_COUNT * SLOT_LEN);
  return Array.from({ length: SLOT_COUNT }, (_, i) => ({
    state: s[i * SLOT_LEN + 0x0A]!, sound: s[i * SLOT_LEN + 0x12]!,
  })).filter(v => v.state !== 0);
}

describe('sound driver queues', () => {
  it('refuses a request when the queue is full and keeps the ones already waiting', () => {
    const { d } = boot();
    for (let n = 1; n <= 8; n++) expect(d.play(n)).toBe(true);
    expect(d.play(9)).toBe(false);                        // the ninth has nowhere to go
    expect(queue(d)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);  // and did not overwrite any of the eight

    d.tick();
    for (let n = 1; n <= 8; n++) expect(d.isPlaying(n)).toBe(true);
    expect(queue(d)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(d.isPlaying(9)).toBe(false);
  });

  it('leaves a request queued while every OPL channel is taken, then starts it', () => {
    const { d } = boot();
    for (let n = 1; n <= 8; n++) d.play(n);               // the queue holds eight
    d.tick();
    expect(d.play(9)).toBe(true);                         // the queue is empty again, but the channels are not
    d.tick();
    for (let n = 1; n <= 9; n++) expect(d.isPlaying(n)).toBe(true);
    expect(busy(d).filter(v => v.sound < 0x40).length).toBe(9);   // all nine channels

    expect(d.play(10)).toBe(true);
    d.tick();                                             // no channel free: the request has to wait
    expect(d.isPlaying(10)).toBe(false);
    expect(queue(d)).toEqual([10, 0, 0, 0, 0, 0, 0, 0]);

    for (let tick = 0; tick < 6 && d.isPlaying(9); tick++) d.tick();
    expect(d.isPlaying(9)).toBe(false);                   // the short effect ended and freed its channel
    for (let tick = 0; tick < 2 && !d.isPlaying(10); tick++) d.tick();
    expect(d.isPlaying(10)).toBe(true);
    expect(queue(d)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('runs requests on both queues, and a refused music request leaves the effect queue alone', () => {
    const { d } = boot();
    for (let n = 1; n <= 8; n++) d.play(n);
    expect(d.play(9, true)).toBe(true);                   // the music queue still has a slot
    expect(queue(d, MUSIC_QUEUE)).toEqual([9, 0, 0, 0, 0, 0, 0, 0]);
    expect(queue(d)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (let n = 10; n <= 16; n++) expect(d.play(n, true)).toBe(true);   // seven more fill the music queue
    expect(d.play(17, true)).toBe(false);
    expect(queue(d, MUSIC_QUEUE)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(queue(d)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('queues an engine note once per car however often engine() is called', () => {
    const { d } = boot();
    for (let i = 0; i < 40; i++) d.engine(0, 0x30 + (i & 0x0F), true);
    expect(queue(d).filter(s => s === 0x40).length).toBe(1);

    d.tick();
    expect(d.isPlaying(0x40)).toBe(true);
    for (let tick = 0; tick < 40; tick++) {
      d.engine(0, 0x30 + (tick & 0x0F), true);            // once a frame, as fn 7b46 does
      d.tick();
      expect(busy(d).filter(v => v.sound === 0x40).length).toBeLessThanOrEqual(1);
    }
    expect(busy(d).filter(v => v.sound === 0x40).length).toBe(1);
    expect(queue(d).includes(0x40)).toBe(false);
    for (const car of [1, 2]) expect(d.isPlaying(0x40 + car)).toBe(false);
  });

  it('lets a stopped car\'s engine end and give its channel back', () => {
    const { d } = boot();
    for (let n = 1; n <= 8; n++) d.play(n);
    d.tick();
    d.engine(0, 0x30, true);
    d.tick();
    expect(d.isPlaying(0x40)).toBe(true);
    expect(busy(d).filter(v => v.sound < 0x40).length).toBe(8);   // eight effects and one engine: full

    expect(d.play(10)).toBe(true);
    d.tick();                                             // the queue cannot start it yet
    expect(d.isPlaying(10)).toBe(false);
    expect(queue(d)).toEqual([10, 0, 0, 0, 0, 0, 0, 0]);

    d.engine(0, 0, false);                                // the car has gone: its record now ends
    d.tick();
    expect(d.isPlaying(0x40)).toBe(false);
    expect(busy(d).some(v => v.sound === 0x40)).toBe(false);

    for (let tick = 0; tick < 5 && !d.isPlaying(10); tick++) d.tick();
    expect(d.isPlaying(10)).toBe(true);                   // the freed channel went to the waiting request
  });

  it('does not let an engine request queued for a stopped car start after it has gone', () => {
    const { d } = boot();
    for (let n = 1; n <= 7; n++) d.play(n);
    d.engine(0, 0x30, true);                              // queued behind the seven effects
    expect(queue(d)).toEqual([1, 2, 3, 4, 5, 6, 7, 0x40]);
    d.engine(0, 0, false);                                // and the car stops before the tick
    expect(queue(d).includes(0x40)).toBe(false);
    d.tick();
    expect(d.isPlaying(0x40)).toBe(false);
    for (let n = 1; n <= 7; n++) expect(d.isPlaying(n)).toBe(true);
  });

  it('keeps an engine note sounding when its car stops and starts again before the tick', () => {
    const { d, log } = boot();
    d.engine(0, 0x30, true);
    d.tick();
    expect(d.isPlaying(0x40)).toBe(true);
    log.writes.length = 0;
    d.engine(0, 0, false);                                // a frame with the car stopped
    d.engine(0, 0x30, true);                              // and straight back again
    d.tick();
    // the record's loop byte is 0x98 again, so the slot loops with the key still down: no note off
    const offs = log.writes.filter(([r, v]) => r >= 0xB0 && r < 0xB9 && (v & 0x20) === 0);
    expect(offs.length).toBe(0);
    expect(d.isPlaying(0x40)).toBe(true);
  });
});

// Shared helpers for the offline-export acceptance pages. Each check page is loaded fresh by the
// dump-dom runner, so every page gets its own virtual-time budget (a headless OfflineAudioContext
// render drains virtual time far beyond the clip's own duration).
export function logTo(id, ...a) {
  const el = document.getElementById(id);
  if (el) el.textContent += a.join(' ') + '\n';
}

export function finish(result) {
  const out = document.createElement('script');
  out.id = 'result';
  out.type = 'application/json';
  out.textContent = JSON.stringify(result);
  document.body.appendChild(out);
  document.title = result.pass ? 'PASS' : 'FAIL';
}

export function makeCanvas(w = 160, h = 90) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Locate the strong energy bursts (the bells) in a rendered AudioBuffer and compare to authored times.
export function detectBellTimes(buffer, expected, toleranceMs = 40) {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const win = Math.floor(sr * 0.02);
  const env = [];
  for (let i = 0; i < data.length; i += win) {
    let e = 0;
    for (let j = i; j < Math.min(i + win, data.length); j++) e += data[j] * data[j];
    env.push(Math.sqrt(e / win));
  }
  const floor = env.reduce((a, b) => a + b, 0) / env.length;
  const peaks = [];
  for (let k = 1; k < env.length - 1; k++) {
    if (env[k] > floor * 4 && env[k] >= env[k - 1] && env[k] >= env[k + 1]) {
      const t = k * 0.02;
      if (!peaks.length || t - peaks[peaks.length - 1] > 0.25) peaks.push(t);
    }
  }
  const matched = expected.map((at) => peaks.find((p) => Math.abs(p - at) < toleranceMs / 1000));
  return { peaks: peaks.slice(0, 10).map((p) => +p.toFixed(3)), matched: matched.map(Boolean) };
}

export function segmentEnergy(buffer, from, to) {
  const sr = buffer.sampleRate;
  const d = buffer.getChannelData(0);
  let s = 0, n = 0;
  for (let i = Math.floor(from * sr); i < Math.floor(to * sr); i++) { s += d[i] * d[i]; n++; }
  return s / Math.max(1, n);
}

// Minimal MP4 reader: movie duration in ms and whether a sound (soun handler) track exists.
function findBox(buf, path) {
  const dv = new DataView(buf);
  const walk = (start, end, depth) => {
    let i = start;
    while (i + 8 <= end && depth < path.length) {
      let size = dv.getUint32(i);
      const type = String.fromCharCode(...new Uint8Array(buf, i + 4, 4));
      if (size === 1) size = Number(dv.getBigUint64(i + 8));
      if (size === 0) size = end - i;
      if (!size || i + size > end) break;
      if (type === path[depth]) {
        if (depth === path.length - 1) return { body: i + 8, end: i + size };
        const inner = walk(i + 8, i + size, depth + 1);
        if (inner) return inner;
      }
      i += size;
    }
    return null;
  };
  return walk(0, buf.byteLength, 0);
}

export function mp4DurationMs(buf) {
  const mvhd = findBox(buf, ['moov', 'mvhd']);
  if (!mvhd) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(mvhd.body) === 1) {
    const timescale = dv.getUint32(mvhd.body + 20);
    const dur = Number(dv.getBigUint64(mvhd.body + 24));
    return (dur * 1000) / timescale;
  }
  const timescale = dv.getUint32(mvhd.body + 12);
  return (dv.getUint32(mvhd.body + 16) * 1000) / timescale;
}

export function hasAudioTrack(buf) {
  const dv = new DataView(buf);
  let found = false;
  const walk = (start, end) => {
    let i = start;
    while (i + 8 <= end) {
      let size = dv.getUint32(i);
      const type = String.fromCharCode(...new Uint8Array(buf, i + 4, 4));
      if (size === 1) size = Number(dv.getBigUint64(i + 8));
      if (size === 0) size = end - i;
      if (!size) break;
      if (type === 'hdlr' && String.fromCharCode(...new Uint8Array(buf, i + 16, 4)) === 'soun') found = true;
      if (['moov', 'trak', 'mdia', 'minf'].includes(type)) walk(i + 8, i + size);
      i += size;
    }
  };
  walk(0, buf.byteLength);
  return found;
}

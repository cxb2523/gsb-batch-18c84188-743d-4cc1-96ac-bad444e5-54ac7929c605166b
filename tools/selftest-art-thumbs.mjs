// 图标缩略图缓存：缓存键含图集版本（大小 + 修改时间），图集替换后同名图标重新生成、
// 旧缓存文件不再命中；同一图标并发请求复用同一个进行中的任务；同图集图标复用解码结果；
// 缓存写盘失败不影响返回；索引查不到的图标返回空。用自造的小尺寸 RGBA 图集，全程离线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-art-thumbs-'));
process.env.CW_DATA_DIR = dir;
process.env.CW_ART_DIR = path.join(dir, 'art');
const artDir = process.env.CW_ART_DIR;
const atlasPath = path.join(artDir, 'ui_test', 'atlas.png');
const thumbsDir = path.join(artDir, '.thumbs');

const { decodePng, encodePng, iconThumb } = await import('../src/art-thumbs.mjs');

let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log('通过：' + name); };

const rgba = (width, height, paint) => {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y).forEach((value, i) => { pixels[(y * width + x) * 4 + i] = value; });
  return { width, height, pixels };
};

// 两版图集：同样的 8×8，颜色不同，替换后同一矩形裁出来的内容必须不一样。
const writeAtlas = (base, mtime) => {
  fs.mkdirSync(path.dirname(atlasPath), { recursive: true });
  fs.writeFileSync(atlasPath, encodePng(rgba(8, 8, (x, y) => [(x * 30 + base) % 256, (y * 30 + base) % 256, base, 255])));
  fs.utimesSync(atlasPath, mtime, mtime);
};

fs.mkdirSync(artDir, { recursive: true });
fs.writeFileSync(path.join(artDir, 'index.json'), JSON.stringify({
  generatedAt: 'selftest',
  pages: ['ui_test/atlas.png'],
  icons: {
    icon_a: { bundle: 'ui_test', page: 'atlas.png', x: 0, y: 0, w: 2, h: 2, rotated: false },
    icon_b: { bundle: 'ui_test', page: 'atlas.png', x: 2, y: 0, w: 2, h: 2, rotated: false },
    icon_c: { bundle: 'ui_test', page: 'atlas.png', x: 0, y: 2, w: 2, h: 2, rotated: true },
    icon_d: { bundle: 'ui_test', page: 'atlas.png', x: 4, y: 4, w: 2, h: 2, rotated: false },
  },
}));
writeAtlas(10, new Date('2026-01-01T00:00:00Z'));

// 统计图集文件的读取与缓存目录的写入次数，用来确认解码复用和单次生成。
let atlasReads = 0;
let cacheWrites = 0;
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
fs.readFileSync = function (file, ...rest) {
  if (String(file) === atlasPath) atlasReads++;
  return realRead.call(this, file, ...rest);
};
fs.writeFileSync = function (file, ...rest) {
  if (String(file).startsWith(thumbsDir)) cacheWrites++;
  return realWrite.call(this, file, ...rest);
};

const thumbPixels = (png) => decodePng(png).pixels;

try {
  await test('首次请求生成缩略图并写缓存，再次请求命中缓存不再解码', async () => {
    const first = await iconThumb('icon_a');
    assert.ok(first);
    assert.equal(atlasReads, 1, '首次要解码一次图集');
    assert.equal(cacheWrites, 1, '首次要写一次缓存');
    assert.equal(fs.readdirSync(thumbsDir).length, 1);
    // icon_a 在图集 (0,0)，左上角像素就是图集的 (0,0)。
    assert.deepEqual([...thumbPixels(first).subarray(0, 4)], [10, 10, 10, 255]);
    const again = await iconThumb('icon_a');
    assert.ok(again.equals(first));
    assert.equal(atlasReads, 1, '缓存命中不再读图集');
    assert.equal(cacheWrites, 1, '缓存命中不再写盘');
    assert.equal(fs.readdirSync(thumbsDir).length, 1);
  });

  await test('同图集的后续图标复用解码结果，裁切位置各自正确', async () => {
    const b = await iconThumb('icon_b');
    assert.ok(b);
    assert.equal(atlasReads, 1, '同图集第二个图标不重复解码');
    // icon_b 在图集 (2,0)，左上角像素是图集的 (2,0)。
    assert.deepEqual([...thumbPixels(b).subarray(0, 4)], [70, 10, 10, 255]);
    assert.equal(fs.readdirSync(thumbsDir).length, 2);
  });

  await test('同一图标并发请求复用同一个进行中的任务，只生成一次', async () => {
    const writesBefore = cacheWrites;
    const results = await Promise.all([iconThumb('icon_c'), iconThumb('icon_c'), iconThumb('icon_c'), iconThumb('icon_c')]);
    for (const png of results) assert.ok(png);
    assert.ok(results.every((png) => png === results[0]), '并发请求拿到的是同一份生成结果');
    assert.equal(cacheWrites, writesBefore + 1, '并发期间只写盘一次');
    assert.equal(atlasReads, 1, '同图集仍然复用解码结果');
    assert.equal(fs.readdirSync(thumbsDir).length, 3);
  });

  await test('图集替换后同一图标名重新生成，旧缓存不再命中', async () => {
    const before = await iconThumb('icon_a');
    const filesBefore = fs.readdirSync(thumbsDir).length;
    const writesBefore = cacheWrites;
    writeAtlas(200, new Date('2026-02-02T00:00:00Z'));
    const after = await iconThumb('icon_a');
    assert.ok(after);
    assert.ok(!after.equals(before), '图集内容变了，返回内容必须跟着变');
    assert.deepEqual([...thumbPixels(after).subarray(0, 4)], [200, 200, 200, 255]);
    assert.equal(atlasReads, 2, '图集版本变了要重新解码');
    assert.equal(cacheWrites, writesBefore + 1, '要重新写回缓存');
    assert.equal(fs.readdirSync(thumbsDir).length, filesBefore + 1, '缓存目录要出现新文件');
    const again = await iconThumb('icon_a');
    assert.ok(again.equals(after), '替换后的新缓存要能命中');
    assert.equal(atlasReads, 2);
    assert.equal(cacheWrites, writesBefore + 1);
  });

  await test('缓存写盘失败只影响本次显示，请求不报错', async () => {
    fs.rmSync(thumbsDir, { recursive: true, force: true });
    fs.writeFileSync(thumbsDir, '占位：.thumbs 变成普通文件，建目录和写缓存都会失败');
    const writesBefore = cacheWrites;
    const png = await iconThumb('icon_d');
    assert.ok(png, '写不进缓存也要返回本次生成的图');
    assert.equal(cacheWrites, writesBefore, '写盘失败被吞掉，没有部分写入');
    assert.deepEqual([...thumbPixels(png).subarray(0, 4)], [320 % 256, 320 % 256, 200, 255]);
    fs.rmSync(thumbsDir, { force: true });
  });

  await test('索引里查不到的图标返回空，不走原型链也不拼路径', async () => {
    for (const name of ['没有这个图标', '__proto__', 'constructor', '../../data/accounts']) {
      assert.equal(await iconThumb(name), null, name);
    }
  });
} finally {
  fs.readFileSync = realRead;
  fs.writeFileSync = realWrite;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`缩略图缓存自检 ${count} 组通过`);

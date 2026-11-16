import fs from 'node:fs';
import path from 'node:path';
import { wechatPackageCandidates } from './platform/client-paths.mjs';
import { decrypt, inspectArchive } from '../tools/wxapkg.mjs';

export const PROTO_BUNDLE = path.resolve(import.meta.dirname, '../work/extracted/_src_chunks_/src/chunks/game.js');
const APPID = 'wx2ea52a972ea18e5e';

function readBundle(file) {
  const input = fs.readFileSync(file);
  if (!/\.wxapkg$/i.test(file)) return input.toString('utf8');
  const { data } = decrypt(APPID, input);
  const entry = inspectArchive(data).files.find(item => item.relativePath === 'src/chunks/game.js');
  if (!entry) throw new Error(file + ' 中缺少 src/chunks/game.js，请使用 _src_chunks_.wxapkg');
  return data.toString('utf8', entry.off, entry.off + entry.size);
}

export function readProtocolSource(bundlePath) {
  const explicit = bundlePath || process.env.CW_PROTO_BUNDLE;
  if (explicit) return readBundle(explicit);
  let cacheError;
  try {
    for (const file of wechatPackageCandidates(APPID)) {
      try { return readBundle(file); }
      catch (error) { cacheError ??= error; }
    }
  } catch (error) { cacheError = error; }
  if (fs.existsSync(PROTO_BUNDLE)) return readBundle(PROTO_BUNDLE);
  if (cacheError) throw cacheError;
  throw new Error('缺少协议文件。请在电脑版微信打开《疯狂水世界》并进入游戏，或设置 CW_PROTO_BUNDLE 指向自己的 _src_chunks_.wxapkg 或解包后的 src/chunks/game.js。');
}

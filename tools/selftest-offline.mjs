import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cw-offline-'));
const cases = [
  ['selftest-storage-transactions.mjs'],
  ['selftest-settings-version.mjs'],
  ['selftest-settings-persistence.mjs'],
  ['selftest-order-reservations.mjs'],
  ['selftest-progression-budgets.mjs'],
  ['selftest-base-status.mjs'],
  ['selftest-pending-operation.mjs'],
  ['selftest-guard-lifecycle.mjs'],
  ['selftest-loop-scheduler.mjs'],
  ['selftest-factory-loop.mjs', '--offline'],
  ['selftest-resource-updater.mjs'],
  ['selftest-trace-log.mjs'],
  ['selftest-console-log.mjs'],
  ['selftest-console-output.mjs'],
  ['selftest-platform-recovery.mjs'],
  ['selftest-capture-recovery-http.mjs'],
  ['selftest-phone-login.mjs'],
  ['selftest-phone-login-http.mjs'],
  ['selftest-phone-login-ui.mjs'],
];

try {
  for (const [index, [file, ...args]] of cases.entries()) {
    const directory = path.join(temporary, String(index));
    fs.mkdirSync(directory);
    const config = path.join(directory, 'config.json');
    fs.writeFileSync(config, '[]');
    console.log(`离线测试 ${index + 1}/${cases.length} ${file}`);
    const result = spawnSync(process.execPath, [path.join(root, 'tools', file), ...args], {
      cwd: root, stdio: 'inherit', windowsHide: true, timeout: 120_000,
      env: { ...process.env, CW_DATA_DIR: directory, CW_CONFIG_PACK: config,
        CW_RESOURCE_DIR: path.join(directory, 'resources'), CW_CA_DIR: path.join(directory, 'certificates'),
        CW_PROTO_BUNDLE: path.join(directory, 'missing-game-protocol.js'), CW_RESOURCE_AUTO_UPDATE: '0' },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, file + ' 离线验证失败');
  }
  console.log(`核心离线测试 ${cases.length}/${cases.length} 组通过`);
} finally {
  assert.equal(path.dirname(temporary), fs.realpathSync(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
}

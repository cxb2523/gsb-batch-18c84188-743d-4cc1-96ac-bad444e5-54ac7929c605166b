// Version migration uses synthetic settings and a temporary data directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SETTINGS_FORMAT, SETTINGS_SCHEMA_VERSION, defaultSettings, migrateSettingsVersion,
  importAutomationSettings, exportAutomationSettings, loadAutomationSettings, saveAutomationSettings,
} from '../src/automation-settings.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-version-'));
const file = path.join(directory, 'settings.json');
let passed = 0;
function test(name, work) { work(); passed++; console.log('通过：' + name); }
function legacySettings() {
  const settings = defaultSettings();
  settings.schedule.stageAuto = true;
  settings.schedule.radarAuto = true;
  settings.schedule.museumExplore = true;
  settings.building.collect = false;
  settings.factory.gain = true;
  settings.radar.enabled = false;
  settings.museum.enabled = false;
  settings.gather.fishing = false;
  delete settings.progression;
  delete settings.login;
  delete settings.merchant;
  delete settings.silicon;
  delete settings.factory.checkEverySeconds;
  delete settings.cityWar.defenceFleetIds;
  delete settings.cityWar.targetPriority;
  delete settings.cityWar.nativeCommissionLimit;
  delete settings.cityWar.defenceTargetMode;
  delete settings.cityWar.defenceTargetPriority;
  delete settings.cityWar.defenceCityRefs;
  delete settings.gather.enabled;
  delete settings.museum.runEnabled;
  delete settings.radar.runEnabled;
  return settings;
}

try {
  test('版本1导入集中补全历史字段，显式选择和输入对象保持原值', () => {
    const settings = legacySettings();
    const before = structuredClone(settings);
    const document = { format: 'crazywaterword-automation', version: 1, settings };
    const migrated = importAutomationSettings(document);
    assert.deepEqual(settings, before);
    assert.equal(migrated.progression.mainline, true);
    assert.equal(migrated.schedule.radarAuto, true);
    assert.equal(migrated.schedule.museumExplore, true);
    assert.equal(migrated.radar.enabled, false);
    assert.equal(migrated.museum.enabled, false);
    assert.equal(migrated.building.collect, false);
    assert.equal(migrated.factory.gain, true);
    assert.equal(migrated.gather.fishing, false);
    assert.equal(migrated.factory.checkEverySeconds, 30);
    assert.deepEqual(migrated.cityWar.defenceFleetIds, []);
    const once = migrateSettingsVersion(settings, 1);
    assert.deepEqual(migrateSettingsVersion(once, 1), once);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(migrated)), migrated);
  });
  test('旧文件加载只在内存迁移，明确保存后使用原版本冲突检查', () => {
    const settings = legacySettings();
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { old: { settings, revision: 7, savedAt: 'old-time' } } }));
    const bytes = fs.readFileSync(file);
    const loaded = loadAutomationSettings('old', { file });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(loaded.revision, 7);
    assert.equal(loaded.savedAt, 'old-time');
    const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
    assert.deepEqual(loaded.settings, imported);
    const saved = saveAutomationSettings('old', loaded.settings, { file, revision: loaded.revision });
    assert.equal(saved.revision, 8);
    assert.deepEqual(loadAutomationSettings('old', { file }).settings, imported);
    assert.equal(JSON.parse(fs.readFileSync(file)).version, SETTINGS_SCHEMA_VERSION);
    assert.throws(() => saveAutomationSettings('old', imported, { file, revision: 7 }), /其他页面更新/);
  });
  test('旧城战共享目标迁移到防守侧，保存与导入保留顺序及独立副本', () => {
    const settings = legacySettings();
    Object.assign(settings.cityWar, {
      enabled: true, fleetIds: ['1远征船', '2远征船'], defenceFleetIds: ['2远征船'],
      targetMode: 'selected', targetPriority: 'original', cityRefs: ['1:3', '1:2'],
    });
    const before = structuredClone(settings);
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { war: { settings, revision: 4 } } }));
    const bytes = fs.readFileSync(file);
    const stored = loadAutomationSettings('war', { file });
    const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(stored.settings, imported);
    assert.deepEqual(settings, before);
    for (const migrated of [stored.settings, imported]) {
      assert.equal(migrated.cityWar.defenceTargetMode, 'selected');
      assert.equal(migrated.cityWar.defenceTargetPriority, 'original');
      assert.deepEqual(migrated.cityWar.defenceCityRefs, ['1:3', '1:2']);
      assert.notEqual(migrated.cityWar.defenceCityRefs, migrated.cityWar.cityRefs);
      assert.deepEqual(migrateSettingsVersion(migrated, 1), migrated);
    }
    imported.cityWar.defenceCityRefs = ['1:3'];
    imported.cityWar.targetMode = 'alliance';
    imported.cityWar.targetPriority = 'fewestAllied';
    saveAutomationSettings('war', imported, { file, revision: stored.revision });
    assert.deepEqual(loadAutomationSettings('war', { file }).settings.cityWar, imported.cityWar);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(imported)).cityWar, imported.cityWar);
  });
  test('城战迁移逐项保留显式防守配置，非法值继续拒绝', () => {
    const settings = legacySettings();
    Object.assign(settings.cityWar, {
      targetMode: 'selected', targetPriority: 'original', cityRefs: ['1:2'],
      defenceTargetMode: 'alliance', defenceCityRefs: [],
    });
    const document = { format: SETTINGS_FORMAT, version: 1, settings };
    const migrated = importAutomationSettings(document);
    assert.equal(migrated.cityWar.defenceTargetMode, 'alliance');
    assert.equal(migrated.cityWar.defenceTargetPriority, 'original');
    assert.deepEqual(migrated.cityWar.defenceCityRefs, []);
    for (const [field, value] of [['defenceTargetMode', null], ['defenceTargetPriority', 'unknown'], ['defenceCityRefs', undefined]]) {
      const invalid = structuredClone(document);
      invalid.settings.cityWar[field] = value;
      assert.throws(() => importAutomationSettings(invalid), error => !!error.fields?.['cityWar.' + field]);
    }
  });
  test('旧账号缺少详细设置时仍返回版本0且不会创建详细配置', () => {
    const bytes = fs.readFileSync(file);
    const loaded = loadAutomationSettings('legacy-native', { file });
    assert.equal(loaded.revision, 0);
    assert.deepEqual(loaded.settings, defaultSettings());
    assert.deepEqual(fs.readFileSync(file), bytes);
  });
  test('严格导入继续拒绝原有必填字段缺失、非法值和未知字段', () => {
    const document = () => ({ format: SETTINGS_FORMAT, version: 1, settings: legacySettings() });
    const missing = document(); delete missing.settings.factory.produce;
    assert.throws(() => importAutomationSettings(missing), error => !!error.fields?.['factory.produce']);
    const invalid = document(); invalid.settings.factory.checkEverySeconds = undefined;
    assert.throws(() => importAutomationSettings(invalid), error => !!error.fields?.['factory.checkEverySeconds']);
    const unknown = document(); unknown.settings.factory.removedField = true;
    assert.throws(() => importAutomationSettings(unknown), /不支持/);
  });
  test('未知版本与损坏文件拒绝写入，保留原文件', () => {
    assert.throws(() => migrateSettingsVersion(defaultSettings(), 2), /版本不支持/);
    assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version: 2, settings: defaultSettings() }), /版本 1/);
    for (const content of ['{broken', JSON.stringify({ version: 2, accounts: {} })]) {
      fs.writeFileSync(file, content);
      assert.throws(() => loadAutomationSettings('old', { file }));
      assert.throws(() => saveAutomationSettings('old', defaultSettings(), { file, revision: 0 }));
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
  });
  console.log(`设置版本迁移验证通过 ${passed} 项。`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

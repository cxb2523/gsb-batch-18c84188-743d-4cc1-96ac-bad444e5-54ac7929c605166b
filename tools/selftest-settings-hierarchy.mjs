// 执行真实层次渲染与显隐函数，使用内存草稿检查依赖关系和错误定位。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultSettings, settingsUiRules } from '../src/automation-settings.mjs';

const source = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const definitions = source.slice(0, source.indexOf("$('config-form').onsubmit"));
assert(definitions.length > 0 && definitions.length < source.length);

function fixture() {
  const env = { nodes: new Map(), saves: 0, focused: null, category: null, group: null };
  class Element {
    constructor(tagName = 'div', className = '', text = '') {
      this.tagName = tagName.toUpperCase(); this.className = className; this.textContent = text;
      this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map();
      this.hidden = false; this.disabled = false; this.valid = true;
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        toggle: (name, force) => {
          const enabled = force ?? !this.classList.contains(name);
          if (enabled) this.classList.add(name); else this.classList.remove(name);
          return enabled;
        },
      };
    }
    get childNodes() { return this.children; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) {
      for (const node of nodes) {
        node.remove(); node.parentElement = this; this.children.push(node);
      }
    }
    prepend(...nodes) {
      for (const node of [...nodes].reverse()) {
        node.remove(); node.parentElement = this; this.children.unshift(node);
      }
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
      this.parentElement = null;
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector) {
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      if (selector === '[data-state]') return this.dataset.state !== undefined;
      if (selector === 'input[type=number]') return this.tagName === 'INPUT' && this.type === 'number';
      if (selector === 'input[type=time]') return this.tagName === 'INPUT' && this.type === 'time';
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(value => value.trim());
      return this.children.flatMap(child => [
        ...(selectors.some(value => child.matches(value)) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    focus() { env.focused = this; }
    scrollIntoView() { this.scrolled = true; }
    checkValidity() { return this.valid; }
    reportValidity() { this.reported = true; return this.valid; }
  }
  env.el = (tagName, className, text) => new Element(tagName, className, text);
  env.node = id => {
    if (!env.nodes.has(id)) env.nodes.set(id, env.el());
    return env.nodes.get(id);
  };
  const api = new Function('env', definitions + `
    const $ = env.node, el = env.el;
    const current = 'hierarchy-fixture';
    const document = { get activeElement() { return env.focused; } };
    const clear = node => { for (const child of [...node.children]) child.remove(); return node; };
    configRenderUsage = () => {};
    configUpdateState = () => {};
    configScheduleSave = () => { env.saves++; };
    configActivate = category => { env.category = category; };
    configActivateGroup = group => { env.group = group; };
    configRenderField = spec => {
      const row = el('div', 'config-row');
      const label = el('div', 'config-label-line');
      const name = el('label', 'config-label', spec.label);
      const box = el('div', 'config-control');
      const control = el(spec.kind === 'number' || spec.kind === 'time' ? 'input' : 'button');
      control.type = spec.kind; control.id = 'config-field-' + spec.key.replaceAll('.', '-');
      const error = el('div', 'config-field-error'); error.hidden = true;
      label.append(name); box.append(control, error); row.append(label, box);
      const widget = { row, control, error, spec, clearError() { error.hidden = true; control.removeAttribute('aria-invalid'); } };
      configEditor.widgets.set(spec.key, widget);
      return row;
    };
    return {
      editor: configEditor, groups: configGroups, collapsed: configCollapsed,
      render: configRenderFields, update: configUpdateVisibility, set: configSet,
      errors: configErrors, check: configCheckForm,
    };
  `)(env);
  api.editor.draft = defaultSettings(); api.editor.baseline = structuredClone(api.editor.draft);
  api.editor.owner = 'hierarchy-fixture'; api.editor.data = { rules: settingsUiRules() };
  return {
    ...api, env,
    widget: key => api.editor.widgets.get(key),
    mount(fields) {
      const host = env.el();
      api.editor.fields.clear(); api.editor.widgets.clear();
      api.render(fields.map(field => ({ category: 'base', groupId: 'fixture', ...field })), host);
      api.update(); return host;
    },
  };
}

const visible = node => !node.hidden && (!node.parentElement || visible(node.parentElement));
const keys = widgets => widgets.map(widget => widget.spec.key);
let passed = 0;
function test(name, run) { run(); passed++; console.log('通过：' + name); }

test('所有显式父项位于同组，字段无重复且依赖无环', () => {
  const f = fixture();
  for (const group of f.groups) {
    const fields = new Map(group.fields.map(field => [field.key, field]));
    assert.equal(fields.size, group.fields.length, group.id);
    for (const field of group.fields) {
      const visited = new Set([field.key]);
      let parent = field.parent;
      while (parent) {
        assert(fields.has(parent), field.key + ' 的父项必须位于同组');
        assert(!visited.has(parent), field.key + ' 不能存在循环依赖');
        visited.add(parent); parent = fields.get(parent).parent;
      }
    }
  }
  const fields = new Map(f.groups.flatMap(group => group.fields.map(field => [field.key, field])));
  for (const [child, parent] of [
    ['farm.crops', 'farm.customPlant'], ['pet.quality', 'pet.breed'],
    ['forge.universalReserve', 'forge.universal'], ['museum.matchedFactor', 'museum.materialFactor'],
    ['merchant.autoBuyPointers', 'merchant.autoSpeedUp'], ['merchant.pointerDailyDiamondLimit', 'merchant.autoBuyPointers'],
    ['silicon.fleets.0.huntPlayers', 'silicon.fleets.0.huntEnabled'],
    ['antique.targetStar', 'antique.star'], ['treasure.maxRepairCost', 'treasure.autoRepair'],
  ]) assert.equal(fields.get(child)?.parent, parent, child);
});

test('不连续的培育参数跟随所属开关，并保持同级设置顺序', () => {
  const f = fixture();
  const fields = f.groups.find(group => group.id === 'pet').fields.filter(field => [
    'pet.breed', 'pet.species', 'pet.release', 'pet.releaseQualities', 'pet.quality', 'pet.universal',
  ].includes(field.key));
  const host = f.mount(fields), breed = f.widget('pet.breed'), release = f.widget('pet.release');
  assert.deepEqual(keys(breed.children), ['pet.species', 'pet.quality', 'pet.universal']);
  assert.deepEqual(keys(release.children), ['pet.releaseQualities']);
  assert.deepEqual(host.children, [breed.node, release.node]);
  assert.equal(f.widget('pet.quality').node.parentElement, breed.childPanel);
});

test('三级开关关闭隐藏全部后代，重新启用保留子开关与预算', () => {
  const f = fixture();
  Object.assign(f.editor.draft.merchant, { autoSpeedUp: true, autoBuyPointers: true, pointerDailyDiamondLimit: 300 });
  f.mount(f.groups.find(group => group.id === 'merchant-week').fields.filter(field => [
    'merchant.autoSpeedUp', 'merchant.autoBuyPointers', 'merchant.pointerDailyDiamondLimit',
  ].includes(field.key)));
  const parent = f.widget('merchant.autoSpeedUp'), purchase = f.widget('merchant.autoBuyPointers');
  const budget = f.widget('merchant.pointerDailyDiamondLimit');
  assert(visible(budget.node));
  f.set('merchant.autoSpeedUp', false);
  assert(!visible(purchase.node)); assert(!visible(budget.node));
  assert.equal(f.editor.draft.merchant.autoBuyPointers, true);
  assert.equal(f.editor.draft.merchant.pointerDailyDiamondLimit, 300);
  f.set('merchant.autoSpeedUp', true);
  assert(visible(budget.node)); assert.equal(parent.disclosure.getAttribute('aria-expanded'), 'true');
});

test('手动收起只改变展示状态，重新启用自动展开所属设置', () => {
  const f = fixture(); f.editor.draft.merchant.autoSpeedUp = true;
  const fields = f.groups.find(group => group.id === 'merchant-week').fields.filter(field => [
    'merchant.autoSpeedUp', 'merchant.dailyPointerLimit',
  ].includes(field.key));
  f.mount(fields);
  const parent = f.widget('merchant.autoSpeedUp'), child = f.widget('merchant.dailyPointerLimit');
  const before = structuredClone(f.editor.draft);
  parent.disclosure.onclick();
  assert(!visible(child.node)); assert.equal(parent.disclosure.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(f.editor.draft, before); assert.equal(f.env.saves, 0);
  f.mount(fields);
  assert(!visible(f.widget('merchant.dailyPointerLimit').node), '重新渲染保留收起状态');
  f.set('merchant.autoSpeedUp', false); f.set('merchant.autoSpeedUp', true);
  assert(visible(f.widget('merchant.dailyPointerLimit').node));
  assert.equal(f.env.saves, 2);
});

test('更换已收起的下拉模式会展开对应参数，并收回隐藏输入的焦点', () => {
  const f = fixture(); f.editor.draft.merchant.firstDepartureMode = 'smart';
  f.mount(f.groups.find(group => group.id === 'merchant-week').fields.filter(field => [
    'merchant.firstDepartureMode', 'merchant.firstDepartureTime', 'merchant.firstDepartureWaitMinutes',
  ].includes(field.key)));
  const mode = f.widget('merchant.firstDepartureMode'), time = f.widget('merchant.firstDepartureTime');
  const wait = f.widget('merchant.firstDepartureWaitMinutes');
  const savedTime = f.editor.draft.merchant.firstDepartureTime;
  const savedWait = f.editor.draft.merchant.firstDepartureWaitMinutes;
  assert(visible(wait.node)); assert(!visible(time.node));
  mode.disclosure.onclick();
  assert(!visible(wait.node)); assert(f.collapsed.has('merchant.firstDepartureMode'));
  f.set('merchant.firstDepartureMode', 'time');
  assert(visible(time.node)); assert(!visible(wait.node));
  assert(!f.collapsed.has('merchant.firstDepartureMode'));
  assert.equal(mode.disclosure.getAttribute('aria-expanded'), 'true');
  time.control.focus(); f.set('merchant.firstDepartureMode', 'smart');
  assert(!visible(time.node)); assert(visible(wait.node));
  assert.equal(f.env.focused, mode.control);
  assert.equal(f.editor.draft.merchant.firstDepartureTime, savedTime);
  assert.equal(f.editor.draft.merchant.firstDepartureWaitMinutes, savedWait);
  assert.equal(f.env.saves, 2);
});

test('收起子组与关闭多层开关时焦点回到仍可见的父控件', () => {
  const f = fixture();
  Object.assign(f.editor.draft.merchant, { autoSpeedUp: true, autoBuyPointers: true });
  f.mount(f.groups.find(group => group.id === 'merchant-week').fields.filter(field => [
    'merchant.autoSpeedUp', 'merchant.autoBuyPointers', 'merchant.pointerDailyDiamondLimit',
  ].includes(field.key)));
  const parent = f.widget('merchant.autoSpeedUp'), purchase = f.widget('merchant.autoBuyPointers');
  const budget = f.widget('merchant.pointerDailyDiamondLimit');
  budget.control.focus(); purchase.disclosure.onclick();
  assert(!visible(budget.node)); assert.equal(f.env.focused, purchase.control);
  assert.equal(f.env.saves, 0);
  purchase.disclosure.onclick(); budget.control.focus();
  f.set('merchant.autoSpeedUp', false);
  assert(!visible(purchase.node)); assert(!visible(budget.node));
  assert.equal(f.env.focused, parent.control); assert(visible(parent.control));
});

test('父项迁往挂机页后子项回到组级，各字段只渲染一次', () => {
  const f = fixture(), moved = new Set(settingsUiRules().controlFields);
  for (const group of f.groups) {
    const fields = group.fields.filter(field => !moved.has(field.key));
    const host = f.mount(fields);
    assert.equal(f.editor.widgets.size, fields.length, group.id);
    for (const field of fields) {
      const widget = f.widget(field.key);
      assert(host.contains(widget.node), field.key);
      if (field.parent && !fields.some(item => item.key === field.parent)) {
        assert(!widget.parentKey, field.key + ' 缺少父项时必须成为根节点');
        assert.equal(widget.node.parentElement, host, field.key);
      }
    }
  }
});

const nestedFields = [
  { key: 'sample.enabled', label: '功能开关', kind: 'switch' },
  { key: 'sample.purchase', label: '购买权限', kind: 'switch', parent: 'sample.enabled', when: draft => draft.sample.enabled },
  { key: 'sample.budget', label: '购买预算', kind: 'number', parent: 'sample.purchase', when: draft => draft.sample.enabled && draft.sample.purchase },
];

test('服务端校验错误展开关闭及手动收起的祖先并定位输入', () => {
  const f = fixture(); f.editor.draft.sample = { enabled: false, purchase: false, budget: -1 };
  f.mount(nestedFields);
  f.collapsed.add('sample.enabled'); f.collapsed.add('sample.purchase'); f.update();
  const budget = f.widget('sample.budget'); assert(!visible(budget.node));
  f.errors({ message: '预算需要修正', fields: { 'sample.budget': '预算不能小于零' } });
  assert(visible(budget.node)); assert.equal(f.env.focused, budget.control);
  assert.equal(f.env.group, 'fixture'); assert.equal(budget.error.hidden, false);
  assert.equal(f.editor.draft.sample.enabled, false); assert.equal(f.editor.draft.sample.purchase, false);
  assert.equal(f.env.saves, 0);
  f.set('sample.budget', 1);
  assert(!visible(budget.node)); assert.equal(budget.error.hidden, true);
  assert.equal(f.env.focused, f.widget('sample.enabled').control);
  assert(visible(f.env.focused));
});

test('本地输入校验展开隐藏的错误项，后台校验保持当前焦点', () => {
  const f = fixture(); f.editor.draft.sample = { enabled: true, purchase: true, budget: 1 };
  f.mount(nestedFields);
  const budget = f.widget('sample.budget'), parent = f.widget('sample.enabled');
  parent.disclosure.onclick(); budget.control.valid = false;
  const previous = f.env.el(); previous.focus();
  assert.equal(f.check({ focus: false }), false);
  assert(visible(budget.node)); assert.equal(f.env.focused, previous);
  assert.equal(f.check(), false); assert.equal(f.env.focused, budget.control); assert(budget.control.reported);
});

console.log(`配置层次专项：${passed}/${passed} 组通过`);

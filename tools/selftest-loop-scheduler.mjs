import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLoopScheduler } from '../src/loop-scheduler.mjs';

let passed = 0;
async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}
function fixture() {
  const client = new EventEmitter();
  client.connected = true;
  const control = new AbortController();
  const jobs = [], sleeps = [];
  const scheduler = createLoopScheduler({
    client, stop: control.signal, now: () => 1000,
    schedule: work => new Promise((resolve, reject) => jobs.push(async () => {
      try { resolve(await work()); } catch (error) { reject(error); }
    })),
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      sleeps.push({ ms, signal, resolve });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  return { client, control, scheduler, jobs, sleeps };
}

await test('到期任务经现有队列执行，重复投递合并', async () => {
  const f = fixture();
  let executed = 0;
  const first = f.scheduler.runDue('factory', () => 900, () => executed++);
  const duplicate = f.scheduler.runDue('factory', () => 900, () => executed++);
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(f.jobs.length, 1);
  assert.equal(executed, 0);
  await f.jobs.shift()();
  await first;
  assert.equal(executed, 1);
  f.scheduler.dispose();
});

await test('排队期间期限或开关变化，在执行点复查', async () => {
  const f = fixture();
  let deadline = 900, executed = 0;
  const job = f.scheduler.runDue('factory', () => deadline, () => executed++);
  await Promise.resolve();
  deadline = Infinity;
  await f.jobs.shift()();
  await job;
  assert.equal(executed, 0);
  await f.scheduler.runDue('factory', () => 2000, () => executed++);
  assert.equal(f.jobs.length, 0);
  f.scheduler.dispose();
});

await test('推送风暴只唤醒等待，取消旧计时器且不投递协议', async () => {
  const f = fixture();
  const wait = f.scheduler.waitUntil(6000);
  assert.equal(f.sleeps[0].ms, 5000);
  for (let i = 0; i < 100; i++) f.scheduler.wake();
  assert.equal(await wait, true);
  assert.equal(f.sleeps[0].signal.aborted, true);
  assert.equal(f.jobs.length, 0);
  const next = f.scheduler.waitUntil(7000);
  assert.equal(f.sleeps.length, 2);
  f.sleeps[1].resolve();
  assert.equal(await next, false);
  f.scheduler.dispose();
});

await test('等待开始前的推送合并为一次即时复查', async () => {
  const f = fixture();
  f.scheduler.wake();
  f.scheduler.wake();
  assert.equal(await f.scheduler.waitUntil(2000), true);
  assert.equal(f.sleeps.length, 0);
  const wait = f.scheduler.waitUntil(2000);
  f.sleeps[0].resolve();
  assert.equal(await wait, false);
  f.scheduler.dispose();
});

for (const reason of ['pause', 'disconnect', 'finite-round']) {
  await test(reason + '退出清理等待、监听和队列中的接续工作', async () => {
    const f = fixture();
    let executed = 0, cleaned = 0;
    f.scheduler.listen(f.client, 'message', () => f.scheduler.wake());
    f.scheduler.addCleanup(() => cleaned++);
    const job = f.scheduler.runDue('factory', () => 0, () => executed++);
    await Promise.resolve();
    const wait = f.scheduler.waitUntil(6000);
    if (reason === 'pause') f.control.abort();
    else if (reason === 'disconnect') { f.client.connected = false; f.client.emit('close'); }
    else f.scheduler.dispose();
    assert.equal(await wait, true);
    assert.equal(f.sleeps[0].signal.aborted, true);
    assert.equal(f.scheduler.active(), false);
    assert.deepEqual(f.client.eventNames(), []);
    await f.jobs.shift()();
    await job;
    f.client.emit('message');
    f.scheduler.wake();
    await f.scheduler.runDue('factory', () => 0, () => executed++);
    assert.equal(executed, 0);
    assert.equal(f.jobs.length, 0);
    f.scheduler.dispose();
    assert.equal(cleaned, 1);
  });
}

await test('同账号恢复时新调度器清空旧运行的唤醒与任务', async () => {
  const f = fixture();
  f.scheduler.wake();
  f.scheduler.dispose();
  const next = createLoopScheduler({ client: f.client, now: () => 1000, sleep: async () => {} });
  assert.equal(await next.waitUntil(2000), false);
  let executed = 0;
  await next.runDue('factory', () => 0, () => executed++);
  assert.equal(executed, 1);
  next.dispose();
});

console.log('循环调度离线专项 ' + passed + '/' + passed + ' 通过');

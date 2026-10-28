'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-store-'));
}

test('appendJsonl/readJsonl 追加读取，坏行跳过', () => {
  const root = tmpRoot();
  const file = path.join(root, 'data', 'jobs.jsonl');
  store.appendJsonl(file, [{ id: 'a' }, { id: 'b' }]);
  store.appendJsonl(file, [{ id: 'c' }]);
  fs.appendFileSync(file, '{bad json}\n');
  assert.deepEqual(store.readJsonl(file).map((r) => r.id), ['a', 'b', 'c']);
});

test('writeJsonl 原子覆盖', () => {
  const root = tmpRoot();
  const file = path.join(root, 'data', 'jobs.jsonl');
  store.writeJsonl(file, [{ id: 'a' }]);
  store.writeJsonl(file, [{ id: 'b' }, { id: 'c' }]);
  assert.deepEqual(store.readJsonl(file).map((r) => r.id), ['b', 'c']);
  assert.equal(fs.readdirSync(path.join(root, 'data')).some((f) => f.includes('.tmp-')), false);
});

test('upsertJobs 按 id 合并：新增、更新 last_seen、保留 first_seen', () => {
  const root = tmpRoot();
  store.writeJsonl(store.defaultPaths(root).jobs, [
    { id: '1', company: 'A', first_seen: '2026-10-01', last_seen: '2026-10-01', total: 80 },
  ]);
  const res = store.upsertJobs(root, [
    { id: '1', company: 'A', first_seen: '2026-10-28', last_seen: '2026-10-28' },
    { id: '2', company: 'B', first_seen: '2026-10-28', last_seen: '2026-10-28', total: 90 },
  ]);
  assert.equal(res.added, 1);
  assert.equal(res.updated, 1);
  const rows = store.readJobs(root);
  const one = rows.find((r) => r.id === '1');
  assert.equal(one.first_seen, '2026-10-01', 'first_seen 不应被新记录覆盖');
  assert.equal(one.last_seen, '2026-10-28');
  assert.equal(one.total, 80, '新记录没给分时应保留旧分');
  assert.equal(rows.length, 2);
});

test('raw 按月分片、run 日志按日写入', () => {
  const root = tmpRoot();
  store.appendRaw(root, '2026-10-28', [{ url: 'https://a.com/1' }]);
  store.appendRaw(root, '2026-10-29', [{ url: 'https://a.com/2' }]);
  assert.equal(store.rawFile(root, '2026-10-28').endsWith(path.join('data', 'raw', '2026-10.jsonl')), true);
  assert.equal(store.readRaw(root, '2026-10-28').length, 2);
  const logFile = store.writeRunLog(root, '2026-10-28', { sources: [] });
  assert.equal(JSON.parse(fs.readFileSync(logFile, 'utf8')).date, '2026-10-28');
});

test('applications 读写', () => {
  const root = tmpRoot();
  assert.deepEqual(store.readApplications(root), []);
  store.writeApplications(root, [{ company: '微创医疗', status: '已投递' }]);
  assert.equal(store.readApplications(root)[0].status, '已投递');
});

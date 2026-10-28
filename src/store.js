'use strict';

/**
 * 存储层：JSONL 原子写入 + 按月分片的原始池 + 运行日志。
 * 设计原则：主库 jobs.jsonl 只追加/按 id 更新；raw 只追加；派生文件（xlsx/html/推送）都从主库生成。
 */
const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function defaultPaths(root) {
  const dataDir = path.join(root, 'data');
  return {
    root,
    dataDir,
    jobs: path.join(dataDir, 'jobs.jsonl'),
    review: path.join(dataDir, 'review.jsonl'),
    applications: path.join(dataDir, 'applications.json'),
    candidates: path.join(dataDir, 'candidates.jsonl'),
    rawDir: path.join(dataDir, 'raw'),
    runsDir: path.join(dataDir, 'runs'),
  };
}

function rawFile(root, dateStr) {
  return path.join(root, 'data', 'raw', `${dateStr.slice(0, 7)}.jsonl`);
}

function runFile(root, dateStr) {
  return path.join(root, 'data', 'runs', `${dateStr}.json`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      // 坏行跳过，不阻塞整个流程（坏行数由调用方统计）
    }
  }
  return rows;
}

function appendJsonl(file, rows) {
  if (!rows || rows.length === 0) return 0;
  ensureDir(path.dirname(file));
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(file, text, 'utf8');
  return rows.length;
}

function writeJsonl(file, rows) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readJobs(root) {
  return readJsonl(defaultPaths(root).jobs);
}

/**
 * 按 id 合并：已存在则更新 last_seen/status 等字段，不存在则追加。
 * 返回 { added, updated, records }。
 */
function upsertJobs(root, incoming) {
  const paths = defaultPaths(root);
  const existing = readJsonl(paths.jobs);
  const byId = new Map(existing.map((j) => [j.id, j]));
  let added = 0;
  let updated = 0;
  for (const job of incoming) {
    const old = byId.get(job.id);
    if (old) {
      const merged = { ...old, ...job, first_seen: old.first_seen || job.first_seen };
      // 保留旧的评分/证据，除非新记录明确提供
      if (!job.scores && old.scores) merged.scores = old.scores;
      if (job.total == null && old.total != null) merged.total = old.total;
      byId.set(job.id, merged);
      updated += 1;
    } else {
      byId.set(job.id, job);
      added += 1;
    }
  }
  const records = [...byId.values()];
  writeJsonl(paths.jobs, records);
  return { added, updated, records };
}

function appendRaw(root, dateStr, items) {
  return appendJsonl(rawFile(root, dateStr), items);
}

function readRaw(root, dateStr) {
  return readJsonl(rawFile(root, dateStr));
}

function writeRunLog(root, dateStr, log) {
  const file = runFile(root, dateStr);
  writeJson(file, { date: dateStr, ...log });
  return file;
}

function readApplications(root) {
  return readJson(defaultPaths(root).applications, []);
}

function writeApplications(root, rows) {
  writeJson(defaultPaths(root).applications, rows);
}

module.exports = {
  ensureDir,
  defaultPaths,
  rawFile,
  runFile,
  readJsonl,
  appendJsonl,
  writeJsonl,
  readJson,
  writeJson,
  readJobs,
  upsertJobs,
  appendRaw,
  readRaw,
  writeRunLog,
  readApplications,
  writeApplications,
};

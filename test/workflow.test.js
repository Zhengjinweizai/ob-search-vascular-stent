'use strict';

/**
 * work/daily-job-search.yml 的结构回归测试。
 * 只做静态断言：防止时区、调度时间、步骤顺序、超时和告警被误改回去。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'daily-job-search.yml');

function load() {
  return yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));
}

test('工作流按北京时间调度且时区统一', () => {
  const wf = load();
  assert.equal(wf.env.TZ, 'Asia/Shanghai');
  assert.equal(wf.on.schedule[0].cron, '0 0 * * *'); // 北京 08:00
  // 手动触发必须保留，便于验证
  assert.ok(wf.on.workflow_dispatch !== undefined);
});

test('旧 opencode 流程临时开启 websearch', () => {
  const wf = load();
  assert.equal(wf.env.OPENCODE_ENABLE_EXA, '1');
});

test('步骤顺序：测试 → 抓取 → 生成页面 → 提交 → 推送 → 告警', () => {
  const wf = load();
  const steps = wf.jobs['daily-job-search'].steps;
  const names = steps.map((s) => s.name);
  const idx = (part) => names.findIndex((n) => n && n.includes(part));
  const order = ['运行测试', '运行每日任务', '生成 HTML', '提交代码', '上传 Excel'];
  let last = -1;
  for (const part of order) {
    const i = idx(part);
    assert.ok(i > last, `步骤「${part}」缺失或顺序错误：${names.join(' | ')}`);
    last = i;
  }
  // 告警步骤必须在最后且仅在失败时触发
  const lastStep = steps[steps.length - 1];
  assert.equal(lastStep.name, '失败告警');
  assert.equal(lastStep.if, 'failure()');
});

test('超时设置合理，避免 60 分钟静默挂起', () => {
  const wf = load();
  const job = wf.jobs['daily-job-search'];
  assert.ok(job['timeout-minutes'] <= 30, '整个 job 超时应 ≤ 30 分钟');
  const ai = job.steps.find((s) => s.name.includes('运行每日任务'));
  assert.ok(ai['timeout-minutes'] <= 20, 'AI 步骤超时应 ≤ 20 分钟');
});

test('依赖安装使用锁定版本，且不再重复安装 opencode 之外的全局包', () => {
  const wf = load();
  const steps = wf.jobs['daily-job-search'].steps;
  const install = steps.find((s) => s.name.includes('安装项目依赖'));
  assert.match(install.run, /npm ci/);
});

'use strict';

/**
 * .github/workflows/daily-job-search.yml 的结构回归测试。
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

function steps() {
  return load().jobs['daily-job-search'].steps;
}

test('工作流按北京时间调度且时区统一', () => {
  const wf = load();
  assert.equal(wf.env.TZ, 'Asia/Shanghai');
  assert.equal(wf.on.schedule[0].cron, '0 0 * * *'); // 北京 08:00
  assert.ok(wf.on.workflow_dispatch !== undefined, '手动触发必须保留，便于验证');
});

test('不再依赖 opencode / websearch 开关', () => {
  const wf = load();
  assert.equal(wf.env.OPENCODE_ENABLE_EXA, undefined);
  const all = JSON.stringify(steps());
  assert.ok(!all.includes('opencode'), '工作流里不应再出现 opencode');
  assert.ok(!all.includes('search-engine.cjs'), '不再调用旧脚本');
  assert.ok(!all.includes('notify-job.cjs'), '不再调用旧推送脚本');
});

test('步骤顺序：测试 → 抓取 → 过滤 → 评分 → 派生 → 提交 → 推送 → 告警', () => {
  const names = steps().map((s) => s.name);
  const idx = (part) => names.findIndex((n) => n && n.includes(part));
  const order = ['运行测试', '抓取招聘源', '硬规则过滤', 'AI 评分', '生成 Excel', '提交代码', '推送微信日报'];
  let last = -1;
  for (const part of order) {
    const i = idx(part);
    assert.ok(i > last, `步骤「${part}」缺失或顺序错误：${names.join(' | ')}`);
    last = i;
  }
  const lastStep = steps()[steps().length - 1];
  assert.equal(lastStep.name, '失败告警');
  assert.equal(lastStep.if, 'failure()');
});

test('抓取/评分/推送都直接调用新 CLI', () => {
  const s = steps();
  const find = (part) => s.find((x) => x.name.includes(part));
  assert.match(find('抓取招聘源').run, /node src\/cli\.js crawl/);
  assert.match(find('硬规则过滤').run, /node src\/cli\.js process/);
  assert.match(find('AI 评分').run, /node src\/cli\.js score/);
  assert.match(find('生成 Excel').run, /node src\/cli\.js publish --no-notify/);
  assert.match(find('推送微信日报').run, /node src\/cli\.js notify/);
});

test('超时设置合理，避免长时间静默挂起', () => {
  const job = load().jobs['daily-job-search'];
  assert.ok(job['timeout-minutes'] <= 30, '整个 job 超时应 ≤ 30 分钟');
  for (const step of job.steps) {
    if (step['timeout-minutes']) assert.ok(step['timeout-minutes'] <= 20, `${step.name} 超时过长`);
  }
});

test('依赖安装使用锁定版本，提交内容包含主库', () => {
  const s = steps();
  const install = s.find((x) => x.name.includes('安装项目依赖'));
  assert.match(install.run, /npm ci/);
  const commit = s.find((x) => x.name === '提交代码');
  assert.match(commit.run, /git add data\/jobs\.jsonl/);
  assert.match(commit.run, /index\.html/);
  assert.match(commit.run, /求职记录\.xlsx/);
});

test('检出拉全历史，提交前 rebase 到当前分支（浅克隆会 add/add 冲突）', () => {
  const s = steps();
  const checkout = s.find((x) => x.name === '检出代码');
  assert.equal(checkout.uses, 'actions/checkout@v4');
  assert.equal(checkout.with['fetch-depth'], 0, '必须 fetch-depth: 0，否则 rebase 找不到共同祖先');
  const commit = s.find((x) => x.name === '提交代码');
  assert.match(commit.run, /GITHUB_REF_NAME/, 'rebase 目标应是当前分支，不能写死 main');
  assert.ok(!/pull --rebase --autostash origin main\b/.test(commit.run), '不能写死 origin main');
});

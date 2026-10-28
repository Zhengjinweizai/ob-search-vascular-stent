'use strict';
/**
 * 方案 B 命令行入口。
 *
 * 用法：
 *   node src/cli.js crawl [--full] [--only=xjtu_campus,dlut_campus]
 *   node src/cli.js process [--all] [--no-validate]
 *   node src/cli.js check
 */

const { repoRoot, loadConfig, allCities } = require('./config');
const { HttpClient } = require('./http');
const { todayStr } = require('./date');
const store = require('./store');
const { crawlAll, enabledSources } = require('./sources');
const { extractCandidate } = require('./extract');
const { gate } = require('./filter');
const { UrlValidator } = require('./validate');

function parseArgs(argv) {
  const args = { _: [] };
  for (const token of argv) {
    if (token === '--full') args.full = true;
    else if (token === '--all') args.all = true;
    else if (token === '--no-validate') args.noValidate = true;
    else if (token.startsWith('--only=')) args.only = token.slice(7).split(',').filter(Boolean);
    else if (token.startsWith('--')) args[token.slice(2)] = true;
    else args._.push(token);
  }
  return args;
}

function makeHttp(cfg) {
  const crawl = cfg.search.crawl || {};
  return new HttpClient({
    timeoutMs: crawl.timeout_ms || 15000,
    retries: crawl.retries ?? 2,
    concurrency: crawl.concurrency || 4,
  });
}

async function cmdCrawl(args) {
  const cfg = loadConfig(repoRoot());
  const http = makeHttp(cfg);
  const today = todayStr();
  const log = (msg) => console.log(msg);
  log(`== 抓取 ${today}${args.full ? '（全量模式）' : ''}`);
  const { items, stats } = await crawlAll(cfg, { http, log, full: Boolean(args.full), only: args.only });

  // 抓取失败的源要显式暴露出来（静默失败是旧流程最大的坑之一）
  const failed = stats.filter((s) => s.error || s.httpErrors);
  store.appendRaw(repoRoot(), today, items);
  const funnel = {
    sources: stats,
    failedSources: failed.map((s) => ({ source: s.source, error: s.error || `httpErrors=${s.httpErrors}` })),
    raw: items.length,
    bySource: items.reduce((acc, it) => {
      acc[it.source] = (acc[it.source] || 0) + 1;
      return acc;
    }, {}),
  };
  log(`== 原始条目 ${items.length} 条（来源：${Object.entries(funnel.bySource).map(([k, v]) => `${k}=${v}`).join(', ') || '无'}）`);
  if (failed.length) log(`!! ${failed.length} 个源有问题：${failed.map((s) => s.source).join(', ')}`);
  log('写入 data/raw/' + today.slice(0, 7) + '.jsonl');
  return failed.length === 0 && items.length > 0 ? 0 : 1;
}

async function cmdProcess(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const http = makeHttp(cfg);
  const today = args.all ? null : todayStr();
  const raw = store.readRaw(root, todayStr()).filter((it) => !today || String(it.fetched_at || '').startsWith(today));
  const log = (msg) => console.log(msg);
  log(`== 处理 ${raw.length} 条原始记录${today ? `（仅 ${today} 抓取）` : '（全部）'}`);

  // 1) 抽取 + 去重
  const byId = new Map();
  const funnel = { raw: raw.length, extracted: 0, dupInRun: 0 };
  for (const item of raw) {
    try {
      const job = extractCandidate(item, cfg);
      funnel.extracted += 1;
      if (byId.has(job.id)) {
        funnel.dupInRun += 1;
        continue;
      }
      byId.set(job.id, job);
    } catch (err) {
      log(`  ! 抽取失败 ${item.company}/${item.title}：${err.message}`);
    }
  }
  log(`   抽取 ${funnel.extracted}，同批重复 ${funnel.dupInRun}，唯一 ${byId.size}`);

  // 2) URL 校验（只校验要保留的岗位深链；公告链接来自交易所接口，直接信任 200）
  const validator = new UrlValidator({ http });
  if (!args.noValidate) {
    const targets = [...byId.values()].filter((j) => j.kind === 'position' && !j.is_search_url);
    let done = 0;
    for (const job of targets) {
      const res = await validator.validate(job.url);
      job.url_ok = res.ok;
      job.url_status = res.status;
      job.url_quality = res.quality;
      done += 1;
      if (done % 20 === 0) log(`   校验 URL ${done}/${targets.length}`);
    }
    // 公告：接口返回的详情页 URL 记为 deep_link（打开由用户浏览器完成）
    for (const job of byId.values()) {
      if (job.kind === 'announcement') {
        job.url_ok = true;
        job.url_quality = 'deep_link';
      }
    }
  }

  // 3) 硬规则
  const keep = [];
  const review = [];
  const skipReasons = {};
  for (const job of byId.values()) {
    if (!args.noValidate && job.kind === 'position' && !job.url_ok) {
      skipReasons.url_unreachable = (skipReasons.url_unreachable || 0) + 1;
      continue;
    }
    const g = gate(job, cfg);
    job.gate = { action: g.action, reasons: g.reasons };
    if (g.action === 'keep') keep.push(job);
    else if (g.action === 'review') review.push(job);
    else {
      for (const r of g.reasons) skipReasons[r] = (skipReasons[r] || 0) + 1;
    }
  }
  log(`   保留 ${keep.length}，人工复核 ${review.length}，丢弃 ${Object.values(skipReasons).reduce((a, b) => a + b, 0)}`);
  log(`   丢弃原因：${JSON.stringify(skipReasons)}`);

  store.writeJsonl(store.defaultPaths(root).candidates, keep);
  store.writeJsonl(store.defaultPaths(root).review, review);
  const runLog = {
    funnel: {
      ...funnel,
      keep: keep.length,
      review: review.length,
      skipReasons,
      urlStats: validator.stats,
    },
    byKind: keep.reduce((acc, j) => {
      acc[j.kind] = (acc[j.kind] || 0) + 1;
      return acc;
    }, {}),
  };
  store.writeRunLog(root, todayStr(), { stage: 'process', ...runLog });
  log(`== 写入 data/candidates.jsonl（${keep.length} 条）与 data/review.jsonl（${review.length} 条）`);
  return keep.length > 0 ? 0 : 1;
}

function cmdCheck() {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const jobs = store.readJobs(root);
  const apps = store.readApplications(root);
  const sources = enabledSources(cfg);
  console.log(`== 配置检查`);
  console.log(`   城市：${allCities(cfg.search).join('、')}`);
  console.log(`   岗位族：${(cfg.search.job_families.include || []).join('、')}（排除 ${(cfg.search.job_families.exclude || []).join('、')}）`);
  console.log(`   强推阈值：${cfg.profile.thresholds.strong} / 每日上限 ${cfg.profile.thresholds.daily_cap}`);
  console.log(`   启用数据源：${sources.length} 个（${sources.map((s) => s.id).join(', ') || '无'}）`);
  console.log(`== 数据检查`);
  console.log(`   jobs.jsonl：${jobs.length} 条`);
  console.log(`   applications：${apps.length} 条`);
  const byStatus = jobs.reduce((acc, j) => {
    acc[j.status || 'unknown'] = (acc[j.status || 'unknown'] || 0) + 1;
    return acc;
  }, {});
  console.log(`   状态分布：${JSON.stringify(byStatus)}`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'crawl') return cmdCrawl(args);
  if (cmd === 'process') return cmdProcess(args);
  if (cmd === 'check') return cmdCheck();
  console.log('用法：node src/cli.js <crawl|process|check> [选项]');
  return 2;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
}

module.exports = { main, parseArgs };

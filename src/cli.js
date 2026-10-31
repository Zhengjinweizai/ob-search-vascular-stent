'use strict';
const path = require('node:path');
/**
 * 方案 B 命令行入口。
 *
 * 用法：
 *   node src/cli.js crawl [--full] [--only=xjtu_campus,dlut_campus]
 *   node src/cli.js process [--all] [--no-validate]
 *   node src/cli.js score [--recheck] [--limit=N]
 *   node src/cli.js publish [--no-notify] [--dry-run]
 *   node src/cli.js notify [--dry-run]
 *   node src/cli.js prune [--dry-run]   清理主库里与专业方向无关的历史岗位
 *   node src/cli.js weekly [--push]
 *   node src/cli.js run [--full]
 *   node src/cli.js check
 */

const { repoRoot, loadConfig, allCities } = require('./config');
const { HttpClient } = require('./http');
const { todayStr } = require('./date');
const store = require('./store');
const { crawlAll, enabledSources, crawlFatal } = require('./sources');
const { extractCandidate } = require('./extract');
const { gate } = require('./filter');
const { UrlValidator } = require('./validate');
const { Scorer } = require('./score');
const { writeExcel } = require('./derive/excel');
const { writeHtml } = require('./derive/html');
const { notify } = require('./derive/notify');

function parseArgs(argv) {
  const args = { _: [] };
  for (const token of argv) {
    if (token === '--full') args.full = true;
    else if (token === '--all') args.all = true;
    else if (token === '--no-validate') args.noValidate = true;
    else if (token.startsWith('--only=')) args.only = token.slice(7).split(',').filter(Boolean);
    else if (token.startsWith('--limit=')) args.limit = Number(token.slice(8));
    else if (token === '--no-notify') args.noNotify = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--recheck') args.recheck = true;
    else if (token === '--strict') args.strict = true;
    else if (token === '--allow-heuristic') args.allowHeuristic = true;
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
  if (failed.length) log('   （源级失败不阻塞流水线；需要严格模式请加 --strict）');
  return crawlFatal({ items, failed, strict: Boolean(args.strict) }) ? 1 : 0;
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
      const existing = byId.get(job.id);
      if (existing) {
        funnel.dupInRun += 1;
        // 同一条岗位可能被多次抓取：保留信息更完整的那份（后来的抓取通常补全了要求与地点）
        // 以最新一次抓取为准：旧记录可能是「反诈提示」占位文本或只到省级的地点
        const newer = String(job.fetched_at || '') > String(existing.fetched_at || '');
        const sameTime = String(job.fetched_at || '') === String(existing.fetched_at || '');
        const longer = ((job.requirement || '').length + (job.location_raw || '').length)
          >= ((existing.requirement || '').length + (existing.location_raw || '').length);
        const richer = newer || (sameTime && longer);
        if (richer) byId.set(job.id, { ...job, first_seen: existing.first_seen || job.first_seen });
        continue;
      }
      byId.set(job.id, job);
    } catch (err) {
      log(`  ! 抽取失败 ${item.company}/${item.title}：${err.message}`);
    }
  }
  log(`   抽取 ${funnel.extracted}，同批重复 ${funnel.dupInRun}，唯一 ${byId.size}`);

  // 2) 硬规则（纯本地判断，先跑，快）
  const keep = [];
  const review = [];
  const skipReasons = {};
  for (const job of byId.values()) {
    const g = gate(job, cfg);
    job.gate = { action: g.action, reasons: g.reasons };
    if (g.action === 'keep') keep.push(job);
    else if (g.action === 'review') review.push(job);
    else {
      for (const r of g.reasons) skipReasons[r] = (skipReasons[r] || 0) + 1;
    }
  }

  // 3) URL 存活校验（只校验“活下来的”岗位深链；公告与平台链接不走 HTTP 校验）
  //    - 公告：链接来自高校/企业接口，本身有效
  //    - 平台链接（BOSS/猎聘/智联/51job）：反爬必然失败，不能因此丢岗位；标 platform_link 交给用户点击
  let validatorStats = {};
  if (!args.noValidate) {
    const PLATFORM_HOSTS = /(^|\.)(zhipin|liepin|zhaopin|51job|lagou|maimai|nowcoder)\.(com|cn)$/i;
    const fastHttp = new HttpClient({ timeoutMs: 6000, retries: 0, concurrency: 8 });
    const validator = new UrlValidator({ http: fastHttp });
    const targets = [...keep, ...review].filter((job) => {
      if (job.kind === 'announcement') return false;
      if (job.is_search_url) return false;
      let host = '';
      try {
        host = new URL(job.url).hostname;
      } catch {
        return false;
      }
      if (PLATFORM_HOSTS.test(host)) {
        job.url_ok = null;
        job.url_quality = 'platform_link';
        return false;
      }
      return true;
    });
    log(`   校验 URL ${targets.length} 条（keep ${keep.length} / review ${review.length} 中的可校验深链）`);
    await Promise.all(
      targets.map(async (job) => {
        const res = await validator.validate(job.url);
        job.url_ok = res.ok;
        job.url_status = res.status;
        job.url_quality = res.quality;
      })
    );
    for (const job of byId.values()) {
      if (job.kind === 'announcement') {
        job.url_ok = true;
        job.url_quality = 'deep_link';
      }
    }
    validatorStats = validator.stats;
    // 校验失败的岗位从 keep/review 中剔除
    for (const list of [keep, review]) {
      for (let k = list.length - 1; k >= 0; k -= 1) {
        if (list[k].kind === 'position' && list[k].url_ok === false) {
          skipReasons.url_unreachable = (skipReasons.url_unreachable || 0) + 1;
          list.splice(k, 1);
        }
      }
    }
  }

  log(`   保留 ${keep.length}，人工复核 ${review.length}，丢弃 ${Object.values(skipReasons).reduce((a, b) => a + b, 0)}`);
  log(`   丢弃原因：${JSON.stringify(skipReasons)}`);

  store.writeJsonl(store.defaultPaths(root).candidates, keep);
  store.writeJsonl(store.defaultPaths(root).review, review);

  // 通过硬规则的岗位写入主库（评分在下一步；upsert 会保留旧的 first_seen/评分）
  // 另外：本次被判为 skip/review、但主库里还是 keep 的旧记录，要同步降级（否则旧岗位会一直留在推荐里）
  const mainDb = store.readJobs(root);
  const keepIds = new Set(keep.map((j) => j.id));
  const demoted = mainDb
    .filter((j) => !keepIds.has(j.id) && j.gate?.action === 'keep')
    .map((j) => {
      const fresh = byId.get(j.id);
      return {
        ...(fresh || j),
        id: j.id,
        gate: fresh?.gate || { action: 'skip', reasons: ['not_in_current_run'] },
        last_seen: j.last_seen,
      };
    });
  const merged = store.upsertJobs(root, [
    ...keep.map((job) => ({ ...job, last_seen: today, status: job.status || 'active', entered_at: today })),
    ...demoted,
  ]);
  if (demoted.length) log(`   主库降级 ${demoted.length} 条（本次不再通过硬规则）`);
  const runLog = {
    funnel: {
      ...funnel,
      keep: keep.length,
      review: review.length,
      skipReasons,
      urlStats: validatorStats,
    },
    byKind: keep.reduce((acc, j) => {
      acc[j.kind] = (acc[j.kind] || 0) + 1;
      return acc;
    }, {}),
  };
  runLog.mainDb = { added: merged.added, updated: merged.updated, total: merged.records.length };
  store.writeRunLog(root, today, { stage: 'process', ...runLog });
  log(`== 写入 data/candidates.jsonl（${keep.length} 条）、data/review.jsonl（${review.length} 条）、主库新增 ${merged.added} / 更新 ${merged.updated}（共 ${merged.records.length}）`);
  return raw.length === 0 ? 1 : 0;
}


async function cmdScore(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const today = todayStr();
  const jobs = store.readJobs(root);
  // 默认只评"通过硬规则且还没评分"的岗位；--recheck 重评全部 keep 岗位
  const targets = jobs.filter((j) => {
    if (args.all) return j.gate?.action === 'keep' || j.gate?.action === 'review';
    if (j.gate?.action !== 'keep') return false;
    if (args.recheck) return true;
    return typeof j.total !== 'number';
  });
  const limit = args.limit ? Number(args.limit) : targets.length;
  const batch = targets.slice(0, Math.max(0, limit));
  const http = makeHttp(cfg);
  const scorer = new Scorer({ http, profile: cfg.profile, concurrency: 3 });
  if (!scorer.enabled) {
    if (!args.allowHeuristic) {
      console.error('!! 未设置 DEEPSEEK_API_KEY：评分步骤中止（本地调试可加 --allow-heuristic）');
      return 1;
    }
    console.log('!! 未设置 DEEPSEEK_API_KEY：使用启发式评分（仅用于本地开发，不要用于线上推荐）');
  }
  console.log(`== 评分 ${batch.length}/${targets.length} 条（模型 ${scorer.model}）`);
  const results = await scorer.scoreJobs(batch, {
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) console.log(`   ${done}/${total}`);
    },
  });
  const updated = [];
  const failed = [];
  for (const r of results) {
    if (!r) continue;
    if (r.error) {
      failed.push({ id: r.job.id, company: r.job.company, title: r.job.title, error: r.error });
      continue;
    }
    const job = {
      ...r.job,
      scores: r.scored.scores,
      evidence: r.scored.evidence,
      why_apply: r.scored.why_apply,
      resume_tips: r.scored.resume_tips,
      total: r.scored.total,
      scored_at: today,
      scored_by: scorer.enabled ? scorer.model : 'heuristic',
      heuristic: Boolean(r.scored.heuristic),
    };
    updated.push(job);
  }
  const res = store.upsertJobs(root, updated);
  console.log(`   评分成功 ${updated.length}，失败 ${failed.length}，写入后主库 ${res.records.length} 条`);
  if (failed.length) {
    console.log(`   失败样例：${failed.slice(0, 5).map((f) => `${f.company}/${f.title}: ${f.error}`).join(' | ')}`);
    const paths = store.defaultPaths(root);
    store.appendJsonl(paths.review, failed.map((f) => ({ ...f, reviewed_at: today, reason: 'score_failed' })));
  }
  store.writeRunLog(root, today, {
    stage: 'score',
    model: scorer.model,
    heuristic: !scorer.enabled,
    targets: targets.length,
    scored: updated.length,
    failed: failed.length,
    tokens: scorer.stats.tokens,
  });
  return failed.length === 0 || updated.length > 0 ? 0 : 1;
}

async function cmdPublish(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const today = todayStr();
  const jobs = store.readJobs(root);
  console.log(`== 派生输出（主库 ${jobs.length} 条）`);
  const excel = await writeExcel(root, { jobs, profile: cfg.profile, today });
  console.log(`   求职记录.xlsx：招聘信息 ${excel.stats.total} 条 / 强推 ${excel.stats.recommend} 条`);
  const html = writeHtml(root, { jobs, profile: cfg.profile, today });
  console.log(`   index.html：${html.total} 条（今日新增 ${html.todayAdded}，强推 ${html.recommend}）`);
  let notifyResult = null;
  if (!args.noNotify) {
    notifyResult = await notify(root, { jobs, profile: cfg.profile, today, dryRun: Boolean(args.dryRun) });
  }
  store.writeRunLog(root, today, {
    stage: 'publish',
    jobs: excel.stats.total,
    recommend: excel.stats.recommend,
    todayAdded: html.todayAdded,
    notify: notifyResult ? { dryRun: Boolean(notifyResult.dryRun), counts: notifyResult.counts, ok: notifyResult.okCount, failed: notifyResult.failed } : null,
  });
  if (notifyResult && !notifyResult.dryRun && notifyResult.okCount === 0 && notifyResult.results.length > 0) return 1;
  return 0;
}

async function cmdNotify(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const today = todayStr();
  const jobs = store.readJobs(root);
  const dryRun = Boolean(args.dryRun);
  const res = await notify(root, { jobs, profile: cfg.profile, today, dryRun });
  store.writeRunLog(root, today, { stage: 'notify', ...res });
  if (dryRun) return 0;
  if (!res.results.length) return 1; // 配了 workflow 却没配推送 key，视为失败，交给告警
  const { deliveryExitCode } = require('./derive/notify');
  const quota = res.results.filter((r) => r.quota).length;
  if (quota) console.log(`   注意：${quota} 个 ServerChan key 当天额度已用完（免费版 5 条/天），已跳过`);
  if (res.okCount === 0) console.log('!! 所有推送渠道都失败了');
  return deliveryExitCode(res);
}

async function cmdWeekly(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const { weekly } = require('./derive/weekly');
  const res = weekly(root, { profile: cfg.profile });
  console.log(res.markdown);
  console.log(`\n== 写入 ${res.file}`);
  if (args.push) {
    const { sendServerChan, sendPushPlus, loadServerChanKeys } = require('./derive/notify');
    for (const key of loadServerChanKeys()) {
      console.log(await sendServerChan(key, res.title, res.markdown));
    }
    const token = process.env.PUSHPLUS_TOKEN;
    if (token) console.log(await sendPushPlus({ token, topic: process.env.PUSHPLUS_TOPIC || '' }, res.title, res.markdown));
  }
  return 0;
}

async function cmdRun(args) {
  const steps = [
    ['crawl', () => cmdCrawl(args)],
    ['process', () => cmdProcess(args)],
    ['score', () => cmdScore(args)],
    ['publish', () => cmdPublish(args)],
  ];
  for (const [name, fn] of steps) {
    const code = await fn();
    if (code !== 0) {
      console.log(`!! 步骤 ${name} 失败（退出码 ${code}），停止后续步骤`);
      return code;
    }
  }
  return 0;
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

/**
 * 清理主库：把与"血管介入/支架/生物材料"方向无关的岗位从 data/jobs.jsonl 里删掉。
 * 规则（与 filter.js 的专业方向口径一致，但更严格，用于历史数据清理）：
 *   1) 岗位名命中 role_exclude（软件/算法/试剂/HR/财务…）→ 删
 *   2) 公司命中 org_exclude（医院/银行/人力…）→ 删
 *   3) 岗位族不在白名单 → 删
 *   4) 公告：公司是核心医疗器械企业、或文本含器械/介入类词才留
 *   5) 岗位：公司是核心心血管/介入企业，或标题/要求命中方向词才留
 */
async function cmdPrune(args) {
  const log = (msg) => console.log(msg);
  const root = repoRoot();
  const cfg = loadConfig(root);
  const rel = cfg.search?.relevance || {};
  const famInclude = cfg.search?.job_families?.include || [];
  const CORE = [
    '心脉', '微创', '乐普', '先健', '赛诺', '北芯', '启明', '沛嘉', '惠泰', '归创',
    '垠艺', '美中双和', '康誉', '赛禾', '百心安', '通桥', '健适', '蓝帆', '泰尔茂',
    '波士顿科学', '美敦力', '雅培', '朝日英科', '波科', '德诺', '华安', '益心', '博迈', '元心', '心通',
  ];
  const DEV = [
    '医疗器械', '医用', '介入', '支架', '导管', '球囊', '植入', '耗材', '心血管',
    '血管', '可降解', '生物材料', '生物相容', '镍钛', '药物洗脱', '密网', '血流导向', '冠脉', '外周',
  ];
  const { guessJobFamily } = require('./normalize');
  const text = (j) => `${j.company || ''} ${j.title || ''} ${j.requirement || ''}`;
  const isCore = (j) => CORE.some((c) => (j.company || '').includes(c));
  const hasDir = (j) => (rel.direction_keywords || []).some((k) => `${j.title || ''} ${j.requirement || ''}`.includes(k));
  const hasDev = (j) => DEV.some((k) => text(j).includes(k));
  // 核心企业也要看岗位名：研发/材料/结构/工艺/质量/注册/设计/仿真这类才算相关（排除"机械工程师"这种通用工程岗）
  const DOMAIN_TITLE = /研发|研究|材料|结构|工艺|质量|注册|设计|仿真|力学|涂层|支架|导管|球囊|介入/;
  const hasDomainTitle = (j) => DOMAIN_TITLE.test(j.title || '');

  const jobs = store.readJobs(root);
  const kept = [];
  const dropped = [];
  for (const job of jobs) {
    const title = job.title || '';
    let family = guessJobFamily(title, '');
    // "其他"但标题是研发/科研/技术岗的，按研发处理（例如"心脑血管植入器械与材料方向 专职科研人员"）
    if (family === '其他' && /研发|科研|研究|技术/.test(title)) family = '研发';
    const textAll = `${title} ${job.requirement || ''}`;
    const isPostdoc = ['博士后', '博后', '博士后研究员'].some((k) => textAll.includes(k));
    let reason = null;
    if ((rel.role_exclude || []).some((k) => title.includes(k))) reason = 'role_excluded';
    else if (isPostdoc) reason = 'postdoc';
    else if (family === '销售市场' || family === '临床医学' || family === '职能') reason = 'family';
    else if (job.kind === 'announcement') {
      if (!(isCore(job) || hasDev(job))) reason = 'not_relevant';
    } else if (!hasDir(job) && !(isCore(job) && hasDomainTitle(job))) reason = 'direction_mismatch';
    if (reason) dropped.push({ reason, job });
    else kept.push(job);
  }

  const byReason = dropped.reduce((acc, d) => {
    acc[d.reason] = (acc[d.reason] || 0) + 1;
    return acc;
  }, {});
  log(`== 主库 ${jobs.length} 条：保留 ${kept.length}，删除 ${dropped.length} ${JSON.stringify(byReason)}`);
  if (args.dryRun) {
    for (const d of dropped.slice(0, 30)) log(`   - [${d.reason}] ${d.job.company || ''} | ${d.job.title || ''}`);
    log('   （--dry-run：没有写盘）');
    return 0;
  }
  const target = store.defaultPaths(root).jobs;
  store.writeJsonl(target, kept);
  log(`== 已重写 ${path.relative(root, target)}（${kept.length} 条）`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'crawl') return cmdCrawl(args);
  if (cmd === 'process') return cmdProcess(args);
  if (cmd === 'score') return cmdScore(args);
  if (cmd === 'publish') return cmdPublish(args);
  if (cmd === 'notify') return cmdNotify(args);
  if (cmd === 'weekly') return cmdWeekly(args);
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'prune') return cmdPrune(args);
  if (cmd === 'check') return cmdCheck();
  console.log('用法：node src/cli.js <crawl|process|score|publish|notify|weekly|prune|run|check> [选项]');
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

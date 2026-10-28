'use strict';
/**
 * 数据源注册表：按 sources.yml 的 kind 分发到对应适配器。
 */

const univAnnouncement = require('./univ-announcement');
const htmlList = require('./html-list');

const ADAPTERS = {
  'univ-announcement': univAnnouncement,
  'html-list': htmlList,
};

function enabledSources(cfg) {
  const list = (cfg.sources && cfg.sources.sources) || [];
  return list.filter((s) => s && s.enabled !== false);
}

/**
 * 抓取所有启用的源。
 * @param {object} cfg loadConfig() 结果
 * @param {{http: import('../http').HttpClient, log?: Function, full?: boolean, only?: string[]}} ctx
 */
async function crawlAll(cfg, ctx) {
  const log = ctx.log || (() => {});
  const sources = enabledSources(cfg).filter((s) => !ctx.only || ctx.only.includes(s.id));
  const items = [];
  const stats = [];
  for (const source of sources) {
    const adapter = ADAPTERS[source.kind];
    if (!adapter) {
      log(`[${source.id}] 未知 kind=${source.kind}，跳过`);
      continue;
    }
    const started = Date.now();
    try {
      const res = await adapter.crawlSource(source, ctx);
      items.push(...res.items);
      stats.push({ ...res.stats, ms: Date.now() - started, label: source.label || source.id });
      log(`[${source.id}] 抓到 ${res.items.length} 条（${((Date.now() - started) / 1000).toFixed(1)}s）`);
    } catch (err) {
      stats.push({ source: source.id, error: err.message, ms: Date.now() - started, label: source.label || source.id });
      log(`[${source.id}] 抓取失败：${err.message}`);
    }
  }
  return { items, stats };
}

/**
 * 抓取退出策略：
 * - 一个源都没抓到 → 失败（今天大概率白跑）
 * - 部分源失败但抓到了东西 → 默认成功（GitHub 海外 runner 访问国内高校站点经常不通，
 *   不能让一个源拖垮整条流水线）；--strict 时才要求全部源成功。
 */
function crawlFatal({ items = [], failed = [], strict = false } = {}) {
  return items.length === 0 || (strict && failed.length > 0);
}

module.exports = { crawlFatal, crawlAll, enabledSources, ADAPTERS };

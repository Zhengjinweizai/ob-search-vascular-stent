'use strict';
/**
 * 数据源注册表：按 sources.yml 的 kind 分发到对应适配器。
 */

const univAnnouncement = require('./univ-announcement');
const htmlList = require('./html-list');
const jsEmbed = require('./js-embed');
const beisenPortal = require('./beisen-portal');

const ADAPTERS = {
  'univ-announcement': univAnnouncement,
  'html-list': htmlList,
  'js-embed': jsEmbed,
  'beisen-portal': beisenPortal,
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
  // 源之间并发（每个源内部仍按页顺序 + 页间 delay）：多接几个源时总耗时不会被串行拖长。
  // 结果按 sources 原顺序收集，保证日志/统计稳定可复现。
  const results = await Promise.all(
    sources.map(async (source) => {
      const adapter = ADAPTERS[source.kind];
      if (!adapter) {
        log(`[${source.id}] 未知 kind=${source.kind}，跳过`);
        return null;
      }
      const started = Date.now();
      try {
        const res = await adapter.crawlSource(source, ctx);
        const ms = Date.now() - started;
        log(`[${source.id}] 抓到 ${res.items.length} 条（${(ms / 1000).toFixed(1)}s）`);
        return { items: res.items, stat: { ...res.stats, ms, label: source.label || source.id } };
      } catch (err) {
        const ms = Date.now() - started;
        log(`[${source.id}] 抓取失败：${err.message}`);
        return { items: [], stat: { source: source.id, error: err.message, ms, label: source.label || source.id } };
      }
    })
  );
  const items = [];
  const stats = [];
  for (const r of results) {
    if (!r) continue;
    items.push(...r.items);
    stats.push(r.stat);
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

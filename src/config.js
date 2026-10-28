'use strict';

/**
 * 配置加载与校验。所有配置集中在仓库根目录的 YAML 里，脚本不做隐式默认值兜底，
 * 配置错了要在启动时就报错（而不是悄悄用旧默认值跑一天）。
 */
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

class ConfigError extends Error {}

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function readYaml(file) {
  if (!fs.existsSync(file)) throw new ConfigError(`配置文件不存在：${file}`);
  try {
    return yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`YAML 解析失败：${file}：${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new ConfigError(message);
}

function validateSearchConfig(cfg) {
  assert(cfg && typeof cfg === 'object', 'search-config.yml 为空');
  assert(cfg.cities && Array.isArray(cfg.cities.core) && cfg.cities.core.length > 0, 'search-config.yml 缺少 cities.core');
  assert(Array.isArray(cfg.cities.extended || []), 'cities.extended 必须是数组');
  assert(cfg.job_families && Array.isArray(cfg.job_families.include) && cfg.job_families.include.length > 0, '缺少 job_families.include');
  assert(Array.isArray(cfg.job_families.exclude || []), 'job_families.exclude 必须是数组');
  assert(typeof cfg.experience?.hard_block_years === 'number', '缺少 experience.hard_block_years');
  assert(Array.isArray(cfg.experience?.relax_keywords || []), 'experience.relax_keywords 必须是数组');
  assert(Number.isInteger(cfg.crawl?.concurrency) && cfg.crawl.concurrency >= 1 && cfg.crawl.concurrency <= 8, 'crawl.concurrency 必须是 1-8 的整数');
  assert(typeof cfg.crawl?.timeout_ms === 'number' && cfg.crawl.timeout_ms >= 1000, 'crawl.timeout_ms 必须 ≥ 1000');
  assert(cfg.queries && Array.isArray(cfg.queries.campus) && Array.isArray(cfg.queries.suffix), 'queries 配置不完整');
  return cfg;
}

function validateProfile(cfg) {
  assert(cfg && typeof cfg === 'object', 'profile_model.yml 为空');
  const weights = cfg.scoring?.weights;
  assert(weights && typeof weights === 'object', 'profile_model.yml 缺少 scoring.weights');
  const keys = ['family', 'skill', 'campus', 'location', 'company', 'research'];
  for (const k of keys) assert(typeof weights[k] === 'number', `scoring.weights.${k} 必须是数字`);
  const sum = keys.reduce((s, k) => s + weights[k], 0);
  assert(Math.abs(sum - 1) < 0.001, `scoring.weights 之和必须为 1（当前 ${sum}）`);
  const th = cfg.thresholds;
  assert(typeof th?.strong === 'number' && typeof th?.consider === 'number', 'thresholds 缺少 strong/consider');
  assert(th.strong > th.consider, 'thresholds.strong 必须大于 thresholds.consider');
  assert(typeof th?.daily_cap === 'number' && th.daily_cap >= 1, 'thresholds.daily_cap 必须 ≥ 1');
  return cfg;
}

function loadConfig(root = repoRoot()) {
  const search = validateSearchConfig(readYaml(path.join(root, 'search-config.yml')));
  const profile = validateProfile(readYaml(path.join(root, 'profile_model.yml')));
  const sourcesFile = path.join(root, 'sources.yml');
  const sources = fs.existsSync(sourcesFile) ? readYaml(sourcesFile) : null;
  return { root, search, profile, sources };
}

function allCities(search) {
  return [...new Set([...(search.cities.core || []), ...(search.cities.extended || [])])];
}

function familyAllowed(search, family) {
  if (!family) return false;
  if ((search.job_families.exclude || []).includes(family)) return false;
  return (search.job_families.include || []).includes(family);
}

module.exports = { ConfigError, repoRoot, readYaml, validateSearchConfig, validateProfile, loadConfig, allCities, familyAllowed };

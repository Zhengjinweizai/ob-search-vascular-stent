'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, allCities, familyAllowed, validateProfile, validateSearchConfig, ConfigError } = require('../src/config');

test('仓库内两份配置可加载且通过校验', () => {
  const cfg = loadConfig();
  assert.ok(cfg.search.cities.core.includes('北京'));
  assert.ok(cfg.search.cities.extended.includes('东莞'));
  assert.ok(cfg.profile.scoring.weights.family > 0);
  const sum = Object.values(cfg.profile.scoring.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.001);
});

test('allCities 合并 core + extended 并去重', () => {
  const cfg = loadConfig();
  const cities = allCities(cfg.search);
  assert.ok(cities.includes('北京') && cities.includes('常州'));
  assert.equal(new Set(cities).size, cities.length);
});

test('familyAllowed：白名单内放行，临床/销售/职能拒绝', () => {
  const { search } = loadConfig();
  assert.equal(familyAllowed(search, '研发'), true);
  assert.equal(familyAllowed(search, '注册法规'), true);
  assert.equal(familyAllowed(search, '临床医学'), false);
  assert.equal(familyAllowed(search, '销售市场'), false);
  assert.equal(familyAllowed(search, '其他'), false);
});

test('validateProfile 能拦住权重之和不为 1 的情况', () => {
  const { profile } = loadConfig();
  const bad = JSON.parse(JSON.stringify(profile));
  bad.scoring.weights.family = 0.99;
  assert.throws(() => validateProfile(bad), ConfigError);
});

test('validateSearchConfig 能拦住非法并发数', () => {
  const { search } = loadConfig();
  const bad = JSON.parse(JSON.stringify(search));
  bad.crawl.concurrency = 99;
  assert.throws(() => validateSearchConfig(bad), ConfigError);
});

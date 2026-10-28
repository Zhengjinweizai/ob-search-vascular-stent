'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const {
  buildMessages,
  parseScoreResponse,
  validateScore,
  totalOf,
  heuristicScores,
  Scorer,
  ScoreError,
  DIMENSIONS,
} = require('../src/score');

const cfg = loadConfig(path.resolve(__dirname, '..'));
const profile = cfg.profile;

const job = {
  id: 'j1',
  source: 'endovastec_social',
  kind: 'position',
  company: '心脉医疗',
  title: '血管支架研发工程师',
  job_family: '研发',
  cities: ['上海'],
  campus: true,
  education_req: '硕士',
  major_req: '生物医学工程、材料',
  requirement: '负责血管支架结构设计与有限元分析，要求熟悉镍钛合金，硕士学历。'.repeat(400),
  url: 'https://www.endovastec.com/SocialRecruitment/',
  first_seen: '2026-10-28',
};

test('buildMessages：包含画像，超长要求被截断', () => {
  const msgs = buildMessages(job, profile);
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /六维/);
  assert.ok(msgs[0].content.includes('血管支架'));
  assert.ok(msgs[1].content.length < 9000, '岗位要求应截断到 6000 字以内');
});

test('parseScoreResponse：容忍 markdown 代码块与前后噪声', () => {
  const text = '说明文字\n```json\n{"scores":{"family":90}}\n```\n结束';
  assert.deepEqual(parseScoreResponse(text), { scores: { family: 90 } });
  assert.throws(() => parseScoreResponse('不是 JSON'), ScoreError);
});

test('validateScore：脚本重算总分，不信任模型给的总分', () => {
  const scores = { family: 90, skill: 80, campus: 70, location: 95, company: 60, research: 85 };
  const evidence = Object.fromEntries(DIMENSIONS.map((k) => [k, '原文证据片段']));
  const out = validateScore(
    { scores, evidence, why_apply: '方向完全对口', resume_tips: '突出有限元项目', total: 999 },
    profile,
  );
  assert.equal(out.total, totalOf(scores, profile.scoring.weights));
  assert.notEqual(out.total, 999);
  assert.ok(out.total <= 100);
});

test('validateScore：缺证据/超范围/缺建议均判无效', () => {
  const evidence = Object.fromEntries(DIMENSIONS.map((k) => [k, '证据']));
  assert.throws(() => validateScore({ scores: { family: 90 }, evidence: { family: '证据' } }, profile), /缺少原文证据/);
  const bad = { ...Object.fromEntries(DIMENSIONS.map((k) => [k, 90])), family: 120 };
  assert.throws(() => validateScore({ scores: bad, evidence }, profile), /分数非法/);
  assert.throws(
    () => validateScore({ scores: Object.fromEntries(DIMENSIONS.map((k) => [k, 95])), evidence }, profile),
    /why_apply/,
  );
});

test('heuristicScores：无 key 时给出确定性分数', () => {
  const s = heuristicScores(job, profile);
  assert.equal(s.heuristic, true);
  assert.ok(s.total > 0 && s.total <= 100);
  assert.deepEqual(Object.keys(s.scores).sort(), [...DIMENSIONS].sort());
});

test('Scorer：没有 API key 时 enabled=false 并走启发式', async () => {
  const scorer = new Scorer({ http: { postJson: async () => ({ ok: true, status: 200, text: '{}', json: {} }) }, profile, apiKey: '' });
  assert.equal(scorer.enabled, false);
  const out = await scorer.scoreJob(job);
  assert.equal(out.heuristic, true);
});

test('Scorer：模型返回非法 JSON 时重试后失败', async () => {
  let calls = 0;
  const http = {
    async postJson() {
      calls += 1;
      return { ok: true, status: 200, json: { choices: [{ message: { content: '抱歉，我无法评分' } }] }, text: '' };
    },
  };
  const scorer = new Scorer({ http, profile, apiKey: 'test-key', concurrency: 1 });
  await assert.rejects(() => scorer.scoreJob(job), ScoreError);
  assert.equal(calls, 2, '应重试一次');
});

test('Scorer：合法响应被接受并带证据', async () => {
  const scores = Object.fromEntries(DIMENSIONS.map((k) => [k, 85]));
  const evidence = Object.fromEntries(DIMENSIONS.map((k) => [k, '要求熟悉血管支架设计']));
  const http = {
    async postJson() {
      return {
        ok: true,
        status: 200,
        json: {
          choices: [{ message: { content: JSON.stringify({ scores, evidence, why_apply: '对口', resume_tips: '突出仿真' }) } }],
          usage: { total_tokens: 1234 },
        },
        text: '',
      };
    },
  };
  const scorer = new Scorer({ http, profile, apiKey: 'test-key', concurrency: 1 });
  const out = await scorer.scoreJob(job);
  assert.equal(out.scores.skill, 85);
  assert.equal(scorer.stats.tokens, 1234);
});

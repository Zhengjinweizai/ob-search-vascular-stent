'use strict';
/**
 * 评分层：DeepSeek 只做"读候选页 → 六维打分 + 证据 + 建议"。
 *
 * 设计要点（对应旧流程的评分通胀）：
 * 1) 总分由脚本按权重重算，不信任模型给的总分；
 * 2) 每个维度必须有原文证据（evidence），缺失即判为无效响应；
 * 3) 推荐与否由 gate（硬规则）决定，分数只负责排序；
 * 4) 没有 API key 时退化为启发式评分（只用于本地开发/CI，不用于生产推荐）。
 */

const { sleep } = require('./http');

const DIMENSIONS = ['family', 'skill', 'campus', 'location', 'company', 'research'];

class ScoreError extends Error {}

function truncate(text, max = 8000) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max)}\n…（已截断）`;
}

/** profile_model.yml 里与评分相关的部分 */
function profileBrief(profile) {
  const p = profile || {};
  return {
    candidate: p.candidate,
    target_roles: p.target_roles,
    superpowers: p.superpowers,
    dimensions: p.dimensions,
    scoring: p.scoring,
    evidence_required_over: p.evidence_required_over,
    apply_advice: p.apply_advice,
  };
}

function buildMessages(job, profile) {
  const payload = {
    title: job.title,
    company: job.company,
    family_guess: job.job_family,
    cities: job.cities,
    kind: job.kind,
    campus: job.campus,
    education: job.education_req,
    major: job.major_req,
    posted_at: job.posted_at,
    deadline: job.deadline,
    requirement: truncate(job.requirement, 6000),
  };
  const system = [
    '你是医疗器械行业招聘评估助手。给你一条招聘信息（公告或岗位），按候选人的六维画像打分。',
    '只输出一个 JSON 对象，不要输出多余文字，不要用 markdown 代码块。',
    'JSON 结构：{"scores":{"family":0-100,"skill":0-100,"campus":0-100,"location":0-100,"company":0-100,"research":0-100},"evidence":{"family":"…","skill":"…","campus":"…","location":"…","company":"…","research":"…"},"why_apply":"一句话（≥60 分必填）","resume_tips":"一句话（≥60 分必填）"}',
    '打分规则：',
    '- 分数必须是 0-100 的整数，不要都给高分：与候选人方向无关的降到 40 以下；',
    '- evidence 必须引用招聘信息里的原文片段（不超过 40 字），不得编造；',
    '- family：岗位族与候选人目标岗位（研发/注册法规/质量/工艺/技术支持）的匹配度；',
    '- skill：岗位要求与候选人技能（材料学、支架结构设计、力学仿真/有限元、三维建模、生物相容性评价、动物实验）的重合度；',
    '- campus：校招/应届友好度（明确校招、接受应届、有培养计划高；要求 3 年以上社招低）；',
    '- location：城市与候选人意向（北京/上海/深圳/苏州优先，杭州/东莞/无锡/常州等次之）的匹配度；',
    '- company：公司平台（上市/细分龙头/科研院所高，初创/外包/中介低）；',
    '- research：研究方向相关度（血管支架/介入器械高，泛医疗器械中，其它低）。',
    '候选人画像与各维度评分锚点：',
    JSON.stringify(profileBrief(profile)),
  ].join('\n');
  const user = `招聘信息：\n${JSON.stringify(payload, null, 2)}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function stripFences(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s;
}

function parseScoreResponse(text) {
  let obj;
  try {
    obj = JSON.parse(stripFences(text));
  } catch (err) {
    throw new ScoreError(`响应不是合法 JSON：${err.message}`);
  }
  return obj;
}

function totalOf(scores, weights) {
  let sum = 0;
  for (const k of DIMENSIONS) sum += (scores[k] || 0) * (weights[k] || 0);
  return Math.round(sum);
}

/**
 * 校验模型输出并以脚本口径重算总分。
 * @returns {{scores:Object<string,number>, evidence:Object<string,string>, why_apply:string, resume_tips:string, total:number}}
 */
function validateScore(obj, profile) {
  if (!obj || typeof obj !== 'object') throw new ScoreError('响应为空或不是对象');
  const raw = obj.scores || {};
  const rawEvidence = obj.evidence || {};
  const scores = {};
  const evidence = {};
  for (const k of DIMENSIONS) {
    const ev = rawEvidence[k];
    if (typeof ev !== 'string' || ev.trim().length < 2) {
      throw new ScoreError(`维度 ${k} 缺少原文证据`);
    }
    evidence[k] = ev.trim().slice(0, 120);
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new ScoreError(`维度 ${k} 分数非法：${JSON.stringify(v)}`);
    }
    scores[k] = Math.round(v);
  }
  const weights = profile.scoring.weights;
  const total = totalOf(scores, weights);
  const needAdvice = total >= (profile.thresholds?.consider ?? 60);
  const why = typeof obj.why_apply === 'string' ? obj.why_apply.trim() : '';
  const tips = typeof obj.resume_tips === 'string' ? obj.resume_tips.trim() : '';
  if (needAdvice && (!why || !tips)) {
    throw new ScoreError(`总分 ${total} ≥ 60，但 why_apply/resume_tips 缺失`);
  }
  return { scores, evidence, why_apply: why.slice(0, 300), resume_tips: tips.slice(0, 300), total };
}

/** 无 API key 时的本地启发式（仅开发/CI 使用，不用于线上推荐） */
function heuristicScores(job, profile) {
  const text = `${job.title || ''} ${job.company || ''} ${job.requirement || ''}`;
  const has = (words) => words.some((w) => text.includes(w));
  const dims = profile.dimensions || {};
  const kw = (dim) => {
    const k = dims?.[dim]?.keywords;
    if (!k) return [];
    if (Array.isArray(k)) return k;
    return [...(k.strong || []), ...(k.weak || [])];
  };
  const exact = dims.research?.keywords?.strong || dims.research?.exact_keywords || [];
  const related = dims.research?.keywords?.weak || dims.research?.related_keywords || [];
  const skills = kw('skill');
  const research = has(exact) ? 92 : has(related) ? 78 : has(['医疗', '器械', '医用', '耗材']) ? 60 : 35;
  const skillHit = skills.filter((w) => text.includes(w)).length;
  const skill = skillHit >= 3 ? 92 : skillHit === 2 ? 78 : skillHit === 1 ? 62 : 40;
  const campus = job.campus ? (has(['校园招聘', '校招', '应届']) ? 95 : 80) : 45;
  const city = (job.cities || []).length ? 90 : 50;
  const company = has(['上市', '股份', '医疗', '科技']) ? 82 : 65;
  const family = job.job_family && ['研发', '注册法规', '质量', '工艺制造', '技术支持'].includes(job.job_family) ? 88 : 45;
  const scores = { family, skill, campus, location: city, company, research };
  return {
    scores,
    evidence: Object.fromEntries(DIMENSIONS.map((k) => [k, '启发式评分（未启用 AI，仅占位）'])),
    why_apply: '',
    resume_tips: '',
    total: totalOf(scores, profile.scoring.weights),
    heuristic: true,
  };
}

class Scorer {
  constructor({ http, profile, apiKey, baseUrl, model, concurrency = 3 }) {
    this.http = http;
    this.profile = profile;
    this.apiKey = apiKey || process.env.DEEPSEEK_API_KEY || '';
    this.baseUrl = (baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    this.concurrency = Math.max(1, concurrency);
    this.stats = { scored: 0, failed: 0, tokens: 0 };
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async callModel(messages) {
    const res = await this.http.postJson(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.model,
        messages,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      },
      { headers: { authorization: `Bearer ${this.apiKey}` }, timeoutMs: 60000, retries: 1 },
    );
    if (!res.ok) throw new ScoreError(`DeepSeek HTTP ${res.status}: ${truncate(res.text, 300)}`);
    if (!res.json?.choices?.[0]?.message?.content) throw new ScoreError('DeepSeek 响应缺少 choices[0].message.content');
    this.stats.tokens += res.json.usage?.total_tokens || 0;
    return res.json.choices[0].message.content;
  }

  async scoreJob(job) {
    if (!this.enabled) return heuristicScores(job, this.profile);
    const messages = buildMessages(job, this.profile);
    let lastErr;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      try {
        const content = await this.callModel(messages);
        const parsed = validateScore(parseScoreResponse(content), this.profile);
        this.stats.scored += 1;
        return parsed;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await sleep(800);
      }
    }
    this.stats.failed += 1;
    throw lastErr;
  }

  /** 批量评分（并发上限内），失败返回 {error} 而不抛错 */
  async scoreJobs(jobs, { onProgress } = {}) {
    const results = [];
    let index = 0;
    const workers = Array.from({ length: this.concurrency }, async () => {
      while (index < jobs.length) {
        const i = index;
        index += 1;
        const job = jobs[i];
        try {
          const scored = await this.scoreJob(job);
          results[i] = { job, scored };
        } catch (err) {
          results[i] = { job, error: err.message };
        }
        if (onProgress) onProgress(i + 1, jobs.length);
      }
    });
    await Promise.all(workers);
    return results;
  }
}

module.exports = {
  DIMENSIONS,
  ScoreError,
  buildMessages,
  parseScoreResponse,
  validateScore,
  totalOf,
  heuristicScores,
  Scorer,
  truncate,
};

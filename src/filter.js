'use strict';
/**
 * 硬规则过滤（脚本执行，不依赖 AI 自觉）。
 * 规则顺序有讲究：先排"绝对不要"的，再排"可能误伤、进人工复核"的。
 */

const { announcementRelevant } = require('./extract');
const { todayStr, parseDate } = require('./date');

const EXP_RE = /(\d+)\s*(?:年以上|年及以上|年\+|年经验|-|~|—|至)\s*(\d+)?\s*年?/;

/** 从要求文本里猜经验年限：返回 {min, max} 或 null */
function parseExperience(text) {
  const s = String(text || '');
  const m = s.match(EXP_RE);
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] ? Number(m[2]) : null;
  if (!Number.isFinite(min) || min > 20) return null;
  return { min, max };
}

/**
 * @param {object} job extractCandidate 输出
 * @param {object} cfg loadConfig() 结果
 * @param {{today?: string}} [opts]
 * @returns {{action: 'keep'|'review'|'skip', reasons: string[]}}
 */
function gate(job, cfg, opts = {}) {
  const today = opts.today || todayStr();
  const search = cfg.search || {};
  const cities = [...(search.cities?.core || []), ...(search.cities?.extended || [])];
  const include = new Set(search.job_families?.include || []);
  const relax = search.experience?.relax_keywords || [];
  const hardYears = Number(search.experience?.hard_block_years || 3);
  const reasons = [];
  let needReview = false;

  // 1. 截止日期已过 → 直接丢
  if (job.deadline && parseDate(job.deadline) && parseDate(job.deadline) < today) {
    return { action: 'skip', reasons: ['expired'] };
  }
  // 2. 搜索页/门户首页 → 不是岗位链接
  if (job.is_search_url) return { action: 'skip', reasons: ['url_invalid'] };
  // 3. 仅招博士 / 博士后 → 丢
  if (job.phd_only) return { action: 'skip', reasons: ['phd_only'] };
  const postdoc = (search.education?.postdoc_keywords || []).some((k) => `${job.title} ${job.requirement}`.includes(k));
  if (postdoc) return { action: 'skip', reasons: ['postdoc'] };
  // 4. 明显无关的组织（医院/人力中介等）→ 丢
  if (job.org_excluded) return { action: 'skip', reasons: ['org_excluded'] };

  if (job.kind === 'announcement') {
    const rel = announcementRelevant(job, cfg);
    if (!rel.keep) return { action: 'skip', reasons: [rel.reason] };
    if (rel.reason === 'city_unknown') needReview = true;
    // 校招公告：城市未知进复核；已知城市通过即可
    return { action: needReview ? 'review' : 'keep', reasons: needReview ? ['city_unknown'] : ['campus_announcement'] };
  }

  // 以下为具体岗位
  // 5. 相关度
  if (!job.medical_relevant) {
    // 岗位族命中但文本没命中行业词时，仍交给 AI 判一次
    if (!job.major_relevant) return { action: 'skip', reasons: ['not_relevant'] };
    needReview = true;
    reasons.push('relevance_uncertain');
  }
  // 5.5 岗位名直接排除（软件/算法/试剂/检验等，公司是医疗器械也不看）
  if (job.role_excluded) return { action: 'skip', reasons: ['role_excluded'] };
  // 5.6 专业方向：标题/要求里没有支架/介入/导管/生物材料等方向词 → 只进复核，不推荐
  if (!job.direction_match) {
    needReview = true;
    reasons.push('direction_uncertain');
  }
  // 6. 岗位族白名单
  if (!include.has(job.job_family)) {
    if (include.size === 0) {
      // 配置缺失时不拦，只记录
      reasons.push('family_unchecked');
    } else {
      return { action: 'skip', reasons: ['family'] };
    }
  }
  // 7. 城市
  if (job.cities.length === 0) {
    needReview = true;
    reasons.push('city_unknown');
  } else if (!job.cities.some((c) => cities.includes(c))) {
    return { action: 'skip', reasons: ['city'] };
  }
  // 8. 经验：≥N 年且非校招 → block；命中放宽词 → 复核
  const exp = parseExperience(`${job.requirement} ${job.title}`);
  if (exp && exp.min >= hardYears && !job.campus) {
    const text = `${job.requirement} ${job.title}`;
    const relaxed = relax.some((k) => text.includes(k));
    if (relaxed) {
      needReview = true;
      reasons.push('experience_relax');
    } else {
      return { action: 'skip', reasons: ['experience'] };
    }
  }
  // 9. 学历
  if (job.phd_only) return { action: 'skip', reasons: ['phd_only'] };

  if (needReview) return { action: 'review', reasons };
  return { action: 'keep', reasons };
}

module.exports = { gate, parseExperience };

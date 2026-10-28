'use strict';

/** 分数 → 档位文案（阈值来自 profile_model.yml.thresholds） */
function matchLevelOf(total, thresholds = {}) {
  const strong = thresholds.strong ?? 88;
  const consider = thresholds.consider ?? 70;
  if (typeof total !== 'number') return '待评分';
  if (total >= strong) return '强烈推荐';
  if (total >= consider) return '值得考虑';
  return '不推荐';
}

module.exports = { matchLevelOf };

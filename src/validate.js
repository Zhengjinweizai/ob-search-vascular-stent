'use strict';
/**
 * URL 校验：只放行"能打开、且不是搜索页/首页"的链接。
 * 结果在单次进程内缓存，避免重复请求同一 URL。
 */

const { canonicalUrl, isSearchOrPortalUrl } = require('./normalize');

const OK_STATUSES = new Set([200, 201, 203, 206]);

function classifyUrl(url) {
  const u = String(url || '');
  try {
    const parsed = new URL(u);
    const host = parsed.hostname;
    const path = parsed.pathname;
    const query = parsed.search;
    if (isSearchOrPortalUrl(u)) return 'search';
    if (/\/(job|jobs|position|recruit)\/[\w-]+/i.test(path)) return 'deep_link';
    if (/recruitmentId=|positionDetailId=|\/job\/\d+|\/zhaopin\/\d+/.test(u)) return 'deep_link';
    if (path === '/' || path === '') return 'portal_home';
    // 列表/栏目页：路径短、无数字 id、带 index/List/Careers 等
    if (path.split('/').filter(Boolean).length <= 2 && !/[0-9a-f]{8,}/i.test(path + query)) return 'company_page';
    return 'company_page';
  } catch {
    return 'invalid';
  }
}

class UrlValidator {
  /** @param {{http: import('./http').HttpClient, cache?: Map<string, object>}} opts */
  constructor(opts) {
    this.http = opts.http;
    this.cache = opts.cache || new Map();
    this.stats = { checked: 0, ok: 0, bad: 0, cached: 0 };
  }

  /**
   * @param {string} url
   * @returns {Promise<{ok: boolean, status: number|null, quality: string, error?: string}>}
   */
  async validate(url) {
    const key = canonicalUrl(url);
    if (this.cache.has(key)) {
      this.stats.cached += 1;
      return this.cache.get(key);
    }
    this.stats.checked += 1;
    const quality = classifyUrl(url);
    let result;
    if (quality === 'search' || quality === 'invalid') {
      result = { ok: false, status: null, quality };
    } else {
      try {
        const res = await this.http.getText(url, { retries: 1 });
        const ok = OK_STATUSES.has(res.status);
        result = { ok, status: res.status, quality };
      } catch (err) {
        result = { ok: false, status: null, quality, error: err.message };
      }
    }
    if (result.ok) this.stats.ok += 1;
    else this.stats.bad += 1;
    this.cache.set(key, result);
    return result;
  }
}

module.exports = { UrlValidator, classifyUrl };

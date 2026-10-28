'use strict';
/**
 * 极简 HTTP 客户端：超时、重试、并发上限、统一 UA。
 * 只用 Node 20 自带的 fetch，不引第三方请求库。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class HttpClient {
  /**
   * @param {{timeoutMs?: number, retries?: number, concurrency?: number, userAgent?: string}} [opts]
   */
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.retries = opts.retries ?? 2;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.userAgent = opts.userAgent || DEFAULT_UA;
    this.active = 0;
    this.waiters = [];
    this.stats = { requests: 0, failures: 0, retries: 0 };
  }

  async _acquire() {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  _release() {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** 单次请求（带超时，不重试） */
  async _once(url, options = {}) {
    const headers = { 'user-agent': this.userAgent, 'accept-language': 'zh-CN,zh;q=0.9', ...(options.headers || {}) };
    const res = await fetch(url, {
      ...options,
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
    });
    this.stats.requests += 1;
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url || url, text, headers: res.headers };
  }

  /**
   * 带重试的请求。404/403 不重试（确定性失败）。
   * @returns {Promise<{ok: boolean, status: number, url: string, text: string}>}
   */
  async request(url, options = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      await this._acquire();
      try {
        const res = await this._once(url, options);
        if (res.ok || res.status === 403 || res.status === 404 || res.status === 410) return res;
        lastErr = new Error(`HTTP ${res.status} ${url}`);
        if (attempt === this.retries) return res;
      } catch (err) {
        lastErr = err;
        this.stats.failures += 1;
      } finally {
        this._release();
      }
      this.stats.retries += 1;
      await sleep(500 * (attempt + 1));
    }
    throw lastErr || new Error(`request failed: ${url}`);
  }

  async getText(url, options = {}) {
    const res = await this.request(url, options);
    return res;
  }

  async getJson(url, options = {}) {
    const res = await this.request(url, options);
    try {
      return { ...res, json: JSON.parse(res.text) };
    } catch {
      return { ...res, json: null };
    }
  }

  async postJson(url, body, options = {}) {
    return this.request(url, {
      ...options,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      body: JSON.stringify(body || {}),
    }).then((res) => {
      let json = null;
      try {
        json = JSON.parse(res.text);
      } catch {
        json = null;
      }
      return { ...res, json };
    });
  }

  async postForm(url, body, options = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body || {})) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    return this.request(url, {
      ...options,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(options.headers || {}) },
      body: params.toString(),
    });
  }
}

module.exports = { HttpClient, DEFAULT_UA, sleep };

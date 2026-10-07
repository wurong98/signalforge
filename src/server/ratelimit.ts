/**
 * 固定窗口限流（按 key 计数）。用于有外部成本或会对外发请求的接口：
 * /api/parse 每次调用都打 LLM（按量计费），/api/webhooks/:id/test 每次都向外发一个 HTTP 请求。
 * 单进程部署，内存计数即可；重启清零可以接受。
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; since: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** 计入一次；返回 0 表示放行，否则返回需等待的秒数 */
  take(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || now - h.since >= this.windowMs) {
      this.hits.set(key, { count: 1, since: now });
      // 顺手清理过期 key，防止 Map 被大量不同 IP 撑爆
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now - v.since >= this.windowMs) this.hits.delete(k);
      return 0;
    }
    if (h.count >= this.limit) return Math.ceil((h.since + this.windowMs - now) / 1000);
    h.count++;
    return 0;
  }
}

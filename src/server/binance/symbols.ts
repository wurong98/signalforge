/**
 * 币安现货交易对目录（REST exchangeInfo）：回答"支持哪些交易对"。
 * 区别于已订阅交易对：这里是"能建 Signal 的"全集，建 Signal 时才会订阅、才有指标数据。
 * 全量 exchangeInfo 较大，缓存 1 小时；拉取失败时沿用旧缓存。
 */

export interface SpotSymbol {
  symbol: string;
  base: string;
  quote: string;
}

const TTL_MS = 3_600_000;

export class SymbolDirectory {
  private cache: { at: number; symbols: SpotSymbol[] } | null = null;
  private inflight: Promise<SpotSymbol[]> | null = null;

  constructor(
    private restUrl: string,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  async list(): Promise<SpotSymbol[]> {
    if (this.cache && this.now() - this.cache.at < TTL_MS) return this.cache.symbols;
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    try {
      return await this.inflight;
    } catch (e) {
      if (this.cache) return this.cache.symbols;
      throw e;
    }
  }

  private async load(): Promise<SpotSymbol[]> {
    const res = await this.fetchFn(`${this.restUrl}/api/v3/exchangeInfo?permissions=SPOT`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
    const data: any = await res.json();
    const symbols: SpotSymbol[] = (data?.symbols ?? [])
      .filter((s: any) => s.status === 'TRADING')
      .map((s: any) => ({ symbol: String(s.symbol), base: String(s.baseAsset), quote: String(s.quoteAsset) }));
    this.cache = { at: this.now(), symbols };
    return symbols;
  }
}

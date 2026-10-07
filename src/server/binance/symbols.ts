/**
 * 币安交易对目录（REST exchangeInfo）：回答"支持哪些交易对"。
 * 区别于已订阅交易对：这里是"能建 Signal 的"全集，建 Signal 时才会订阅、才有指标数据。
 * 全量 exchangeInfo 较大，缓存 1 小时；拉取失败时沿用旧缓存。
 *
 * 现货与 U 本位合约的交易所符号写法相同（都是 BTCUSDT），靠不同的 REST 域名区分；
 * 系统内用市场键区分（合约加 .P，见 dsl.ts marketKey）。
 * 合约只收永续：PERPETUAL（加密货币）与 TRADIFI_PERPETUAL（美股等传统资产永续）；
 * 交割合约（BTCUSDT_251226）会到期换代，不适合长期监控。
 */
import type { Product } from '../../shared/dsl.ts';
import { SYMBOL_RE, marketKey } from '../../shared/dsl.ts';

export interface MarketSymbol {
  /** 交易所原始符号 */
  symbol: string;
  base: string;
  quote: string;
  product: Product;
  /** 市场键：现货 BTCUSDT，合约 BTCUSDT.P */
  key: string;
  /** 合约类型（仅合约）：PERPETUAL / TRADIFI_PERPETUAL */
  contract?: string;
}

const TTL_MS = 3_600_000;
const PERPETUALS = new Set(['PERPETUAL', 'TRADIFI_PERPETUAL']);

export class SymbolDirectory {
  private cache: { at: number; symbols: MarketSymbol[] } | null = null;
  private inflight: Promise<MarketSymbol[]> | null = null;

  constructor(
    private restUrl: string,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = Date.now,
    readonly product: Product = 'spot',
  ) {}

  async list(): Promise<MarketSymbol[]> {
    if (this.cache && this.now() - this.cache.at < TTL_MS) return this.cache.symbols;
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    try {
      return await this.inflight;
    } catch (e) {
      if (this.cache) return this.cache.symbols;
      throw e;
    }
  }

  private async load(): Promise<MarketSymbol[]> {
    const futures = this.product === 'futures';
    const path = futures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo?permissions=SPOT';
    const res = await this.fetchFn(`${this.restUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
    const data: any = await res.json();
    const symbols: MarketSymbol[] = (data?.symbols ?? [])
      .filter((s: any) => s.status === 'TRADING' && SYMBOL_RE.test(String(s.symbol)) && (!futures || PERPETUALS.has(s.contractType)))
      .map((s: any) => {
        const symbol = String(s.symbol);
        return {
          symbol, base: String(s.baseAsset), quote: String(s.quoteAsset), product: this.product,
          key: marketKey({ product: this.product, symbol }),
          ...(futures ? { contract: String(s.contractType) } : {}),
        };
      });
    this.cache = { at: this.now(), symbols };
    return symbols;
  }
}

/** 现货 + 合约目录：一边拉取失败不影响另一边，失败原因见 errors；两边都失败才抛错 */
export class MarketDirectory {
  readonly dirs: SymbolDirectory[];
  errors: Partial<Record<Product, string>> = {};

  constructor(spotRest: string, futuresRest: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now) {
    this.dirs = [new SymbolDirectory(spotRest, fetchFn, now, 'spot'), new SymbolDirectory(futuresRest, fetchFn, now, 'futures')];
  }

  async list(): Promise<MarketSymbol[]> {
    const res = await Promise.allSettled(this.dirs.map((d) => d.list()));
    const errors: Partial<Record<Product, string>> = {};
    res.forEach((r, i) => {
      if (r.status === 'rejected') errors[this.dirs[i].product] = (r.reason as Error).message;
    });
    this.errors = errors;
    if (res.every((r) => r.status === 'rejected')) throw new Error(Object.values(errors).join('; '));
    return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }
}

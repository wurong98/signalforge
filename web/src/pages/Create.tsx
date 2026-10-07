import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SignalSpec } from '../../../src/shared/dsl.ts';
import { marketKey } from '../../../src/shared/dsl.ts';
import { Section, SpecView } from '../components/bits.tsx';
import type { LeafResult } from '../lib.ts';
import { ApiError, api, fmtNum, useLive } from '../lib.ts';

interface ParseResult {
  spec: SignalSpec;
  explanation: string;
  assumptions: string[];
  warnings: string[];
  parser: 'llm' | 'rules';
}
interface Preview {
  subscribed: boolean;
  ready: boolean;
  values: Record<string, number | null>;
  result: { passed: boolean; leaves: LeafResult[] } | null;
}

const EXAMPLES = [
  'BTC 最近 10 秒主动买入金额超过主动卖出金额 3 倍时调用我的 webhook',
  'BTC 30 秒主动卖出是主动买入的 2 倍，并且 5 秒跌幅超过 0.1%',
  'ETH 5 秒内涨幅超过 0.2% 时通知我',
];

export function CreatePage() {
  const { tick } = useLive();
  const nav = useNavigate();
  const [text, setText] = useState(EXAMPLES[0]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [specText, setSpecText] = useState('');
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [webhooks, setWebhooks] = useState<{ id: number; name: string; url: string }[]>([]);
  const [hookMode, setHookMode] = useState<'new' | 'existing' | 'none'>('new');
  const [hookId, setHookId] = useState<number | null>(null);
  const [hookUrl, setHookUrl] = useState('');
  const [hookSecret, setHookSecret] = useState('');

  useEffect(() => {
    api('/webhooks').then((ws) => {
      setWebhooks(ws);
      if (ws.length) {
        setHookMode('existing');
        setHookId(ws[0].id);
      }
    });
  }, []);

  const currentSpec = (): SignalSpec => (editing ? JSON.parse(specText) : parsed!.spec);

  async function run() {
    setBusy(true);
    setErrors([]);
    setParsed(null);
    setPreview(null);
    setEditing(false);
    try {
      const r = await api<ParseResult>('/parse', { body: { text } });
      setParsed(r);
      setSpecText(JSON.stringify(r.spec, null, 2));
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors : [String(e)]);
    } finally {
      setBusy(false);
    }
  }

  async function doPreview() {
    setErrors([]);
    try {
      setPreview(await api<Preview>('/preview', { body: { spec: currentSpec() } }));
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors : [String(e)]);
    }
  }

  // 预览开启后每秒刷新
  useEffect(() => {
    if (!preview) return;
    const t = setInterval(doPreview, 1000);
    return () => clearInterval(t);
  });

  async function create() {
    setErrors([]);
    try {
      const body: any = { spec: currentSpec(), source_text: text };
      if (hookMode === 'existing') body.webhook_id = hookId;
      if (hookMode === 'new') {
        if (!hookUrl) return setErrors(['请填写 Webhook URL，或选择"不绑定"']);
        body.webhook = { name: new URL(hookUrl).host, url: hookUrl, secret: hookSecret };
      }
      const { id } = await api<{ id: number }>('/signals', { body });
      nav(`/signals/${id}`);
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors : [String(e)]);
    }
  }

  function applyJson() {
    try {
      const spec = JSON.parse(specText);
      setParsed((p) => (p ? { ...p, spec } : p));
      setEditing(false);
      setPreview(null);
      setErrors([]);
    } catch (e) {
      setErrors([`JSON 解析失败：${(e as Error).message}`]);
    }
  }

  return (
    <div className="page narrow">
      <div className="hero">
        <h1>What do you want to monitor?</h1>
        <p className="muted">用一句话描述市场现象。系统会把它翻译成可追溯的 Binance 数据、指标与条件，确认后由确定性引擎实时运行。</p>
      </div>
      <div className="prompt">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run();
          }}
          rows={3}
          placeholder="BTC 10 秒主动买盘超过卖盘 3 倍时通知我"
        />
        <div className="prompt-bar">
          <div className="examples">
            {EXAMPLES.map((x) => (
              <button key={x} className="chip" onClick={() => setText(x)}>
                {x.length > 24 ? `${x.slice(0, 24)}…` : x}
              </button>
            ))}
          </div>
          <span className="muted small">{tick?.llm.enabled ? `LLM: ${tick.llm.model}` : 'LLM 未配置 · 规则解析'}</span>
          <button className="primary" onClick={run} disabled={busy || text.trim().length < 2}>
            {busy ? 'Parsing…' : 'Run'}
          </button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="alert bad">
          {errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      {parsed && (
        <div className="card parsed">
          <div className="parsed-head">
            <div>
              <h2>{parsed.spec.title}</h2>
              <code className="muted">{parsed.spec.name}</code>
            </div>
            <span className="tag">{parsed.parser === 'llm' ? 'parsed by LLM' : 'parsed by rules'} · validated</span>
          </div>
          {parsed.explanation && <p className="explanation">{parsed.explanation}</p>}
          {parsed.assumptions.length > 0 && (
            <div className="alert warn">
              <b>Assumptions</b>
              {parsed.assumptions.map((a, i) => (
                <div key={i}>· {a}</div>
              ))}
            </div>
          )}
          {parsed.warnings.map((w, i) => (
            <div key={i} className="alert warn small">{w}</div>
          ))}

          {editing ? (
            <div>
              <textarea className="json" rows={20} value={specText} onChange={(e) => setSpecText(e.target.value)} />
              <div className="row">
                <button onClick={applyJson}>Apply</button>
                <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <SpecView
              spec={parsed.spec}
              values={preview?.values}
              action={
                <div className="hook-form">
                  <div className="seg">
                    {webhooks.length > 0 && (
                      <button className={hookMode === 'existing' ? 'on' : ''} onClick={() => setHookMode('existing')}>Existing</button>
                    )}
                    <button className={hookMode === 'new' ? 'on' : ''} onClick={() => setHookMode('new')}>New URL</button>
                    <button className={hookMode === 'none' ? 'on' : ''} onClick={() => setHookMode('none')}>None</button>
                  </div>
                  {hookMode === 'existing' && (
                    <select value={hookId ?? ''} onChange={(e) => setHookId(Number(e.target.value))}>
                      {webhooks.map((w) => (
                        <option key={w.id} value={w.id}>{w.name} — {w.url}</option>
                      ))}
                    </select>
                  )}
                  {hookMode === 'new' && (
                    <>
                      <input placeholder="https://example.com/webhook" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
                      <input placeholder="Secret（可选，用于 HMAC-SHA256 签名）" value={hookSecret} onChange={(e) => setHookSecret(e.target.value)} />
                    </>
                  )}
                  {hookMode === 'none' && <div className="muted small">仅记录事件，不调用 Webhook</div>}
                </div>
              }
            />
          )}

          {preview && (
            <Section label="Preview · live">
              {!preview.subscribed ? (
                <div className="muted small">{marketKey(parsed.spec.market)} 尚未订阅，创建后开始接收数据。</div>
              ) : !preview.ready ? (
                <div className="muted small">窗口预热中…</div>
              ) : (
                preview.result?.leaves.map((l, i) => (
                  <div key={i} className={`leaf ${l.passed ? 'pass' : 'fail'}`}>
                    <span className="mono">{l.passed ? '✓' : '✗'} {l.expr}</span>
                    <span className="mono muted">
                      {' '}
                      {fmtNum(l.left)} vs {fmtNum(l.right)}
                      {l.ratio !== undefined && ` · ratio ${l.ratio === null ? '—' : l.ratio.toFixed(2)}`}
                    </span>
                  </div>
                ))
              )}
            </Section>
          )}

          <div className="row end">
            {!editing && (
              <button className="ghost" onClick={() => setEditing(true)}>Edit DSL</button>
            )}
            <button onClick={doPreview} disabled={editing}>Preview</button>
            <button className="primary" onClick={create} disabled={editing}>Create Signal</button>
          </div>
        </div>
      )}
    </div>
  );
}

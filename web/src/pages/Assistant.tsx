import { useEffect, useRef, useState } from 'react';
import { ApiError, api, useLive } from '../lib.ts';

/** 助手：行情 / Signal / 事件询问（只读）。与 Create 页分开，见 docs/llm-assistant-plan.md §6 */

interface TraceItem {
  tool: string;
  args: unknown;
  result: unknown;
  ok: boolean;
}
interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** 服务端生成的取数摘要，下一轮原样回传，便于追问引用"刚才的数" */
  digest?: string;
  trace?: TraceItem[];
}
interface ChatResult {
  answer: string;
  trace: TraceItem[];
  digest: string;
}

const STORE_KEY = 'assistant.turns';
const EXAMPLES = [
  'BTC 现在主动买盘强还是卖盘强？',
  '过去 1 小时 BTC 1 分钟收益率最高到多少？',
  '最近 24 小时哪个 Signal 触发最多？',
  '最近有没有 Webhook 投递失败？',
];

function loadTurns(): Turn[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function TraceView({ trace }: { trace: TraceItem[] }) {
  if (!trace.length) return null;
  return (
    <details className="trace">
      <summary className="muted small">数据来源 · {trace.length} 次查询</summary>
      {trace.map((t, i) => (
        <div key={i} className="trace-item">
          <div className="small">
            <code className={t.ok ? '' : 'bad-text'}>{t.tool}</code> <code className="muted">{JSON.stringify(t.args)}</code>
          </div>
          <pre className="formula">{JSON.stringify(t.result, null, 2)}</pre>
        </div>
      ))}
    </details>
  );
}

export function AssistantPage() {
  const { tick } = useLive();
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const llmOff = tick !== null && !tick.llm.enabled;

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(turns));
    } catch {}
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns, busy]);

  async function send(q = text) {
    const content = q.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content }];
    setTurns(next);
    setText('');
    setErrors([]);
    setBusy(true);
    try {
      const r = await api<ChatResult>('/chat', {
        body: {
          // trace 只在本地展示，不回传；digest 足够模型引用上一轮的数
          messages: next.map(({ role, content, digest }) => ({ role, content, ...(digest ? { digest } : {}) })),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      });
      setTurns([...next, { role: 'assistant', content: r.answer, digest: r.digest, trace: r.trace }]);
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors : [String(e)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Assistant</h1>
          <p className="muted">询问行情、你的 Signal、触发记录与 Webhook 投递。只读：数字全部来自实时窗口与数据库，展开「数据来源」可核对。</p>
        </div>
        {turns.length > 0 && (
          <button className="ghost small" onClick={() => setTurns([])} disabled={busy}>
            清空对话
          </button>
        )}
      </div>

      {llmOff && <div className="alert warn">未配置 LLM（LLM_BASE_URL / LLM_API_KEY），助手不可用。创建 Signal 请使用 Create 页（规则解析）。</div>}

      <div className="chat">
        {turns.length === 0 && <div className="empty">从下方示例开始，或直接提问。建 Signal 请到 Create 页。</div>}
        {turns.map((t, i) => (
          <div key={i} className={`msg ${t.role}`}>
            <div className="msg-body">{t.content}</div>
            {t.trace && <TraceView trace={t.trace} />}
          </div>
        ))}
        {busy && <div className="msg assistant muted">查询中…</div>}
        <div ref={endRef} />
      </div>

      {errors.length > 0 && (
        <div className="alert bad">
          {errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      <div className="prompt">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 输入法组字中的回车不发送
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="BTC 现在买盘强还是卖盘强？（Enter 发送，Shift+Enter 换行）"
          disabled={llmOff}
        />
        <div className="prompt-bar">
          <div className="examples">
            {EXAMPLES.map((x) => (
              <button key={x} className="chip" onClick={() => send(x)} disabled={busy || llmOff}>
                {x}
              </button>
            ))}
          </div>
          <span className="muted small">{tick?.llm.enabled ? `LLM: ${tick.llm.model}` : ''}</span>
          <button className="primary" onClick={() => send()} disabled={busy || llmOff || text.trim().length < 1}>
            {busy ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </div>
    </div>
  );
}

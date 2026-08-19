import { parseBlocks, inlineParts } from '../lib/markdown.js';

/** 인라인 굵게만 처리한다. 결과물 문법이 그 이상 쓰지 않는다. */
function Inline({ text }) {
  return inlineParts(text).map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>));
}

/**
 * 결과물·샘플 본문 렌더.
 *
 * `limit`을 주면 앞에서 그만큼의 블록만 그린다. 문자열을 잘라 미리보기를 만들면 표 중간에서
 * 끊겨 형태가 깨지므로, 자르는 단위를 블록으로 둔다.
 */
export default function Markdown({ source, limit = null }) {
  const all = parseBlocks(source);
  const blocks = limit ? all.slice(0, limit) : all;

  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.type === 'h') {
          const Tag = `h${Math.min(4, b.level + 2)}`;
          return <Tag key={i} className={`md-h md-h${b.level}`}><Inline text={b.text} /></Tag>;
        }
        if (b.type === 'hr') return <div key={i} className="md-hr" />;
        if (b.type === 'ul') {
          return (
            <ul key={i} className="md-ul">
              {b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}
            </ul>
          );
        }
        if (b.type === 'table') {
          return (
            <div key={i} className="md-tablewrap">
              <table className="md-table">
                <thead>
                  <tr>{b.head.map((h, j) => <th key={j}><Inline text={h} /></th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>{r.map((c, k) => <td key={k}><Inline text={c} /></td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={i} className="md-p"><Inline text={b.text} /></p>;
      })}
    </div>
  );
}

/**
 * 채점 상세.
 *
 * 총점만 보여주면 "이 점수는 어디서 나왔냐"에 답할 수 없다. 항목·배점·근거를 함께 두는 것이
 * 이 화면의 존재 이유다 — 평점 어뷰징에 대한 방어가 여기서 시작한다.
 */
export default function ScoreTable({ breakdown, criteria }) {
  if (!breakdown?.length) return null;
  const labelOf = (id) => criteria?.find((c) => c.id === id)?.label ?? id;
  const maxOf = (id) => criteria?.find((c) => c.id === id)?.max ?? 20;

  return (
    <table className="score-tbl">
      <tbody>
        {breakdown.map((b) => {
          const max = maxOf(b.id);
          return (
            <tr key={b.id}>
              <th scope="row">{labelOf(b.id)}</th>
              <td className="score-bar">
                <span className="bar"><i style={{ width: `${(b.score / max) * 100}%` }} /></span>
              </td>
              <td className="score-n">{b.score}<span className="score-max"> / {max}</span></td>
              {b.note && <td className="score-note">{b.note}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

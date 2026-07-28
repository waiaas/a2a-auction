import { liveActivity, orderedBuyers } from '../lib/derive.js';

const GRADE = { 'buyer-a': 'A+', 'buyer-b': 'B', 'buyer-c': 'C' };
const FALLBACK = [
  { role: 'buyer-a', emoji: '📊', name: 'Analyst Agent' },
  { role: 'buyer-b', emoji: '🚀', name: 'Growth Agent' },
  { role: 'buyer-c', emoji: '🧪', name: 'Experimental Agent' },
];

/** 우측 rail: Live Activity(실제 state 파생) + Registered Agents(등록 에이전트). */
export default function Rail({ state }) {
  const activity = liveActivity(state);
  const buyers = orderedBuyers(state.buyers);
  const agents = buyers.length ? buyers : FALLBACK;

  return (
    <div className="rail">
      <div className="panel glass">
        <div className="ph">📡 Live Activity</div>
        {activity.length
          ? activity.map((a, i) => (
            <div className="fitem" key={i}>
              <span className="fa">{a.emoji}</span>
              <div><b>{a.who}</b> {a.act}<div className="sub">{a.sub}</div></div>
            </div>
          ))
          : <div className="feed-empty">라운드가 시작되면 에이전트 활동이 여기 표시됩니다.</div>}
      </div>

      <div className="panel glass">
        <div className="ph">🤖 Registered Agents</div>
        {agents.map((a) => (
          <div className="agent" key={a.role}>
            <div className="av">{a.emoji}</div>
            <div><div className="nm">{a.name}</div><div className="rl">{a.role} · WAIaaS</div></div>
            <span className="k">{GRADE[a.role] || '—'}</span>
          </div>
        ))}
        <div className="cta2">
          <div className="b">＋ Connect your agent</div>
          <div className="s">데몬 등록 → 정책 위임 → 자율 비딩</div>
        </div>
      </div>
    </div>
  );
}

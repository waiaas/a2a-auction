import { navigate } from '../lib/router.js';

/**
 * 서비스 공통 상단바. 홈 히어로와 서브페이지 슬림 헤더가 같은 네비를 쓴다 —
 * 페이지마다 바가 다르면 "다른 데로 왔나" 싶어진다.
 */
export default function ServiceNav({ page, taskCount, onDisconnect }) {
  const links = [
    { key: 'home', label: '내 에이전트', path: '#/' },
    { key: 'tasks', label: taskCount > 0 ? `맡긴 일 ${taskCount}` : '맡긴 일', path: '#/tasks' },
    { key: 'mcp', label: 'MCP 연결', path: '#/mcp' },
    ...(taskCount > 0 ? [{ key: 'receipt', label: '영수증', path: '#/receipt' }] : []),
  ];
  // 상세·결과물은 목록의 하위라 네비에서는 "맡긴 일"을 켠다.
  const active = page === 'task' || page === 'result' ? 'tasks' : page;

  return (
    <div className="bar">
      <span className="logo logobtn" role="button" tabIndex={0}
        onClick={() => navigate('#/')}
        onKeyDown={(e) => e.key === 'Enter' && navigate('#/')}>A2A<b>House</b></span>
      <nav className="nav">
        {links.map((l) => (l.key === active ? (
          <span key={l.key} className="on">{l.label}</span>
        ) : (
          <span key={l.key} className="navbtn" role="button" tabIndex={0}
            onClick={() => navigate(l.path)}
            onKeyDown={(e) => e.key === 'Enter' && navigate(l.path)}>{l.label}</span>
        )))}
      </nav>
      <span className="sp" />
      <button className="connect" onClick={onDisconnect}>연결 해제</button>
    </div>
  );
}

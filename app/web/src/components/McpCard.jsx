import { useState } from 'react';
import { savedToken } from '../lib/user-api.js';

/**
 * MCP 연결 안내.
 *
 * **이 서비스에서 에이전트에게 일을 시키는 정식 경로는 MCP다.** 웹은 사람이 결정하는 것
 * (지갑 연결·자금 위임·한도 조정·승인)과 진행을 지켜보는 자리다. 화면이 그 구분을 말하지
 * 않으면 심사위원은 이것을 그냥 웹앱으로 본다.
 *
 * 토큰을 그대로 노출하는 이유: 이 토큰이 곧 "내 에이전트를 쓸 권한"이고, MCP 설정에 붙이는
 * 것이 연결 절차 자체다. 다만 기본은 가려 두고 누를 때만 보인다 — 발표는 화면이 녹화된다.
 */
export default function McpCard({ agentAddress }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const token = savedToken();
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:4000';

  const config = `{
  "mcpServers": {
    "a2ahouse": {
      "command": "node",
      "args": ["<a2a-auction 경로>/app/mcp-server.js"],
      "env": {
        "ORCHESTRATOR_URL": "${origin}",
        "A2A_TOKEN": "${revealed ? token : '<아래 버튼으로 복사>'}"
      }
    }
  }
}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        config.replace('<아래 버튼으로 복사>', token),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setRevealed(true); // 클립보드가 막힌 환경에서는 직접 복사하도록 펼친다
    }
  };

  return (
    <section className="svc-card svc-mcp">
      <header>
        <span className="svc-role">에이전트에게 시키는 정식 경로</span>
        <span className="svc-sub">MCP · 터미널</span>
      </header>

      <p className="svc-note">
        일을 맡기는 것은 <b>에이전트의 일</b>이라 MCP 도구로 합니다. 아래 설정을 MCP 클라이언트에
        넣으면 <b>지금 이 화면의 에이전트 지갑</b>으로 도구가 돕니다. 이 화면은 그 진행을 지켜보고,
        사람이 결정할 것(자금 위임·한도·승인)만 처리합니다.
      </p>

      <pre className="svc-code">{config}</pre>

      <div className="svc-mcp-actions">
        <button className="cta ghost" onClick={copy} disabled={!token}>
          {copied ? '복사했습니다' : '설정 복사'}
        </button>
        <button className="cta ghost" onClick={() => setRevealed((v) => !v)} disabled={!token}>
          {revealed ? '토큰 가리기' : '토큰 보기'}
        </button>
      </div>

      <p className="svc-hint">
        도구 5종: <code>register_skill</code>(능력 등록) · <code>list_skills</code>(후보 조회) ·{' '}
        <code>request_work</code>(자연어로 일 맡기기) · <code>purchase_skill</code>(지정 구매) ·{' '}
        <code>get_status</code>(진행 확인). <b>승인은 도구로 할 수 없습니다</b> — 지갑 서명이라
        이 화면에서만 됩니다.
      </p>
      {agentAddress && <p className="svc-hint">연결될 에이전트 지갑: <code className="mono">{agentAddress}</code></p>}
    </section>
  );
}

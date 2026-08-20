import { useState } from 'react';
import { shortAddress } from '../lib/base58.js';

/**
 * 두 지갑을 나란히 보여준다.
 *
 * **이 화면의 핵심은 지갑이 둘이라는 사실 자체다.** 내 지갑과 에이전트 지갑이 나뉘어 있고,
 * 그 사이를 건너는 입금이 곧 위임이다. 하나로 합쳐 보여주면 "얼마까지 맡겼는가"라는 이
 * 서비스의 주제가 화면에서 사라진다.
 */
export default function WalletCards({ me, onFaucet, onDeposit, busy }) {
  const [amount, setAmount] = useState('20');
  if (!me) return null;

  const owner = me.owner ?? {};
  const agent = me.agent ?? {};
  // 체험용 SOL이 소진되면 접속자가 직접 받아와야 한다. 잔고가 0인 채로 버튼만 눌리게 두면
  // 사용자는 어디서 막혔는지 모른 채 같은 버튼을 반복한다. 이 플래그가 오너 SOL 표시의
  // 스위치도 겸한다 — 보여줘야 할 유일한 순간이 곧 "모자랄 때"다.
  const needsOwnSol = me.faucet?.ok === false && !(owner.sol > 0);

  return (
    <div className="svc-wallets-grid">
      <section className="svc-card">
        <header>
          <span className="svc-role">내 지갑</span>
          <code className="mono">{shortAddress(me.ownerAddress, 6, 6)}</code>
        </header>
        <div className="svc-bal">
          <b className="tnum">{fmt(owner.usdc)}</b> USDC
          {/* 오너 SOL은 **부족할 때만** 보여준다. faucet이 연결 시점에 채워 주고(`faucet.js`)
              쓰는 곳도 입금 한 번뿐이라, 평소에는 답이 정해진 숫자가 결제 통화 옆에서
              시선만 가져간다. 모자랄 때는 아래 안내와 함께 실제 잔고를 드러낸다. */}
          {needsOwnSol && <span className="svc-sub tnum">수수료 {fmt(owner.sol, 3)} SOL</span>}
        </div>
        <p className="svc-note">여기 있는 돈은 에이전트가 손대지 못합니다.</p>
        <button className="cta ghost" disabled={busy} onClick={onFaucet}>
          체험용 USDC 받기
        </button>
        {needsOwnSol && (
          <p className="svc-hint">
            {me.faucet?.reason ?? '체험용 SOL이 소진됐습니다.'}{' '}
            <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">공식 faucet</a>에서
            받아 이 주소로 보내 주세요. USDC는 위 버튼으로 받으시면 됩니다.
          </p>
        )}
      </section>

      <section className="svc-arrow">
        <div className="svc-arrow-line" />
        <span>맡기기</span>
        <div className="svc-deposit">
          <input
            type="number"
            min="1"
            step="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="맡길 금액(USDC)"
          />
          <button className="cta" disabled={busy} onClick={() => onDeposit(Number(amount))}>
            입금
          </button>
        </div>
        <p className="svc-hint">
          내 서명으로 보냅니다. 보낸 만큼이 위임 한도의 상한이 되고, 에이전트가 낼 수수료도 함께 실립니다.
        </p>
      </section>

      {/* 클래스명에 `agent`를 단독으로 쓰지 않는다 — 기존 에이전트 목록 스타일(`.agent`)이
          display:flex라 카드 내부가 가로로 눕는다. */}
      <section className="svc-card svc-agent">
        <header>
          <span className="svc-role">에이전트 지갑</span>
          <code className="mono">{shortAddress(me.agentAddress, 6, 6)}</code>
        </header>
        <div className="svc-bal">
          <b className="tnum">{fmt(agent.usdc)}</b> USDC
          <span className="svc-sub tnum">수수료 {fmt(agent.sol, 3)} SOL</span>
        </div>
        <p className="svc-note">에이전트가 쓸 수 있는 돈입니다. 정책이 이 안에서 다시 한 번 가릅니다.</p>
      </section>
    </div>
  );
}

const fmt = (n, digits = 2) => (typeof n === 'number' ? Number(n.toFixed(digits)) : '—');

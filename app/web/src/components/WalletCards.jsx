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
  // 가스를 서비스가 대주지 않는 환경에서는 SOL이 없으면 아무것도 못 한다. 잔고가 0인
  // 채로 버튼만 눌리게 두면 사용자는 어디서 막혔는지 모른 채 같은 버튼을 반복한다.
  const needsOwnSol = me.faucet?.grantsSol === false && !(owner.sol > 0);

  return (
    <div className="svc-wallets-grid">
      <section className="svc-card">
        <header>
          <span className="svc-role">내 지갑</span>
          <code className="mono">{shortAddress(me.ownerAddress, 6, 6)}</code>
        </header>
        <div className="svc-bal">
          <b className="tnum">{fmt(owner.usdc)}</b> USDC
          <span className="svc-sub tnum">{fmt(owner.sol, 3)} SOL</span>
        </div>
        <p className="svc-note">여기 있는 돈은 에이전트가 손대지 못합니다.</p>
        <button className="cta ghost" disabled={busy} onClick={onFaucet}>
          체험용 USDC 받기
        </button>
        {needsOwnSol && (
          <p className="svc-hint">
            수수료를 낼 devnet SOL이 필요합니다.{' '}
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
          내 서명으로 보냅니다. 보낸 만큼이 위임 한도의 상한이 되고, 에이전트가 쓸 가스도 함께 실립니다.
        </p>
      </section>

      <section className="svc-card agent">
        <header>
          <span className="svc-role">에이전트 지갑</span>
          <code className="mono">{shortAddress(me.agentAddress, 6, 6)}</code>
        </header>
        <div className="svc-bal">
          <b className="tnum">{fmt(agent.usdc)}</b> USDC
          <span className="svc-sub tnum">가스 {fmt(agent.sol, 3)} SOL</span>
        </div>
        <p className="svc-note">에이전트가 쓸 수 있는 돈입니다. 정책이 이 안에서 다시 한 번 가릅니다.</p>
      </section>
    </div>
  );
}

const fmt = (n, digits = 2) => (typeof n === 'number' ? Number(n.toFixed(digits)) : '—');

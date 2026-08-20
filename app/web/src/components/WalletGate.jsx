import { useEffect, useState } from 'react';
import { discoverWallets, supportsLocalWallet } from '../lib/wallet.js';

/**
 * 연결 화면.
 *
 * 지갑이 하나도 없는 브라우저에서도 막히지 않게 임시 체험 지갑을 함께 낸다. 심사위원이
 * 익스텐션을 설치해야 첫 화면을 넘어갈 수 있다면, 그 지점에서 대부분이 되돌아간다.
 */
export default function WalletGate({ onConnect, busy, error, reconnect = false }) {
  const [wallets, setWallets] = useState([]);
  const [canLocal, setCanLocal] = useState(false);

  useEffect(() => {
    // 익스텐션이 늦게 주입되는 경우가 있어 잠시 뒤 한 번 더 훑는다.
    const scan = () => setWallets(discoverWallets());
    scan();
    const t = setTimeout(scan, 600);
    supportsLocalWallet().then(setCanLocal);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="svc-gate">
      <h2>내 에이전트에게 일을 맡겨 보세요</h2>
      <p className="svc-lede">
        지갑을 연결하면 <b>나만의 에이전트 지갑</b>이 만들어집니다. 내가 맡긴 금액 안에서만
        에이전트가 스스로 능력을 사고, 한도를 넘는 지출은 내 서명을 받아야 진행됩니다.
      </p>

      <div className="svc-wallets">
        {wallets.map((w) => (
          <button key={w.name} className="cta" disabled={busy} onClick={() => onConnect({ type: 'standard', wallet: w })}>
            {w.icon && <img src={w.icon} alt="" width="18" height="18" />}
            {w.name} {reconnect ? '다시 연결' : '연결'}
          </button>
        ))}
        {canLocal && (
          /* 설치된 지갑이 없으면 이 버튼이 **유일한 진입 경로**다. 그때까지 보조(ghost)
             스타일이면 회색 알약이 하나 놓인 화면이 되어 비활성처럼 읽힌다. */
          <button
            className={`cta ${wallets.length ? 'ghost' : ''}`}
            disabled={busy}
            onClick={() => onConnect({ type: 'local' })}
          >
            {reconnect ? '임시 체험 지갑 다시 연결' : '임시 체험 지갑으로 시작'}
          </button>
        )}
      </div>

      {!wallets.length && !reconnect && (
        <p className="svc-hint">
          설치된 지갑이 보이지 않습니다. D&apos;CENT나 Phantom 익스텐션이 있으면 새로고침해 주세요.
          {canLocal && ' 지금 바로 보시려면 임시 체험 지갑으로 시작하셔도 됩니다.'}
        </p>
      )}
      {busy && <p className="svc-hint">지갑에서 서명을 기다리는 중입니다…</p>}
      {error && <div className="errbar">{error}</div>}
    </div>
  );
}

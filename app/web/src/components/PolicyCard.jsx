import { useEffect, useState } from 'react';

/**
 * 내 위임 한도.
 *
 * **이 카드가 이 데모에서 가장 중요한 조작 지점이다.** 숫자 두 개를 바꾸고 같은 것을 다시
 * 사면 판정이 달라진다. 정책 엔진이 화면 문구가 아니라 실제로 작동한다는 것을 사용자가
 * 스스로 확인하는 유일한 방법이라, 값과 결과의 인과를 문장으로 붙여 준다.
 */
export default function PolicyCard({ policy, agentUsdc, onSave, busy }) {
  const [notify, setNotify] = useState('');
  const [delay, setDelay] = useState('');
  const [msg, setMsg] = useState(null);

  // 서버 값이 들어오면 입력칸을 맞춘다. 사용자가 편집 중이면 덮지 않는다.
  useEffect(() => {
    if (policy && notify === '' && delay === '') {
      setNotify(String(policy.notifyMaxUsdc ?? 0));
      setDelay(String(policy.delayMaxUsdc ?? 0));
    }
  }, [policy]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setMsg(null);
    try {
      const out = await onSave(Number(notify), Number(delay));
      setMsg({ ok: true, text: `한도를 ${out.notifyMaxUsdc}/${out.delayMaxUsdc} USDC로 바꿨습니다.` });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };

  return (
    <section className="svc-card svc-policy">
      <header>
        <span className="svc-role">내가 정한 한도</span>
        {typeof agentUsdc === 'number' && <span className="svc-sub">맡긴 금액 {agentUsdc} USDC까지 설정 가능</span>}
      </header>

      <div className="svc-policy-row">
        <label>
          <span>이 금액까지는 알림만</span>
          <input type="number" min="0" step="1" value={notify} onChange={(e) => setNotify(e.target.value)} />
          <em>USDC</em>
        </label>
        <label>
          <span>이 금액까지는 잠시 유예</span>
          <input type="number" min="0" step="1" value={delay} onChange={(e) => setDelay(e.target.value)} />
          <em>USDC</em>
        </label>
        <button className="cta" disabled={busy} onClick={save}>한도 적용</button>
      </div>

      <p className="svc-note">
        <b>{notify || 0} USDC</b>까지는 알림만 가고 그대로 진행됩니다.{' '}
        <b>{delay || 0} USDC</b>까지는 {policy?.delaySeconds ?? 60}초 유예 후 진행되고, 그 사이에
        취소할 수 있습니다. 그보다 큰 금액은 <b>내 지갑 서명</b> 없이는 나가지 않습니다.
      </p>
      {msg && <p className={msg.ok ? 'svc-ok' : 'svc-bad'}>{msg.text}</p>}
    </section>
  );
}

import { truncTx } from '../lib/derive.js';
import { useCluster, txUrl } from '../lib/explorer.js';

/**
 * 온체인 서명 칩. **공개 체인이면 explorer 링크, 로컬 체인이면 복사.**
 *
 * 두 영수증(발표용 `Receipt`, 사용자용 `PurchaseReceipt`)이 같은 것을 쓴다 — 심사위원이
 * 보는 화면과 발표자가 보는 화면에서 증거의 무게가 달라질 이유가 없다.
 */
export default function TxLink({ sig, label, chars }) {
  const cluster = useCluster();
  if (!sig) return <span className="tx dim">—</span>;

  const text = `${label ? `${label} ` : ''}${chars ? truncTx(sig, chars, chars) : truncTx(sig)}`;
  const url = txUrl(sig, cluster);

  // 로컬 체인: explorer가 닿지 못하므로 링크 대신 기존 복사 동작을 유지한다.
  if (!url) {
    return (
      <span className="tx tap" title={sig} onClick={() => copy(sig)}>{text}</span>
    );
  }

  return (
    <a className="tx link" href={url} target="_blank" rel="noreferrer" title={`${sig}\nexplorer에서 열기`}>
      {text}
      <svg className="tx-ext" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
        <path d="M9 3h12v12M21 3L9 15M18 14v7H3V6h7" />
      </svg>
    </a>
  );
}

function copy(text) {
  if (text) navigator.clipboard?.writeText(text).catch(() => {});
}

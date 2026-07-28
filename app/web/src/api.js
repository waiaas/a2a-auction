/**
 * 오케스트레이터(:4000) 얇은 클라이언트. 프론트는 상대경로만 쓴다(dev=Vite proxy, prod=정적 서빙 동일 오리진).
 * 폴링은 App이 1초 간격으로 fetchState()를 호출한다.
 */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function fetchState() {
  const res = await fetch('/api/auction/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json();
}

/** 발표자 Start 버튼. 이미 실행 중이면 409(무시). */
export async function startAuction() {
  const res = await fetch('/api/auction/start', { method: 'POST', headers: JSON_HEADERS });
  if (res.status === 409) return { alreadyRunning: true };
  if (!res.ok) throw new Error(`start ${res.status}`);
  return res.json();
}

/** 다음 라운드 준비(새 auction 계정). 실행 중이면 409. */
export async function resetAuction(scenario = 'default') {
  const res = await fetch('/api/auction/reset', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ scenario }),
  });
  if (!res.ok) throw new Error(`reset ${res.status}`);
  return res.json();
}

/** SettlementReceipt(증거 체인 전체). 정산 전(404)이면 null. */
export async function fetchReceipt() {
  const res = await fetch('/api/receipt', { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`receipt ${res.status}`);
  return res.json();
}

/**
 * seller 결과 unlock. 정산 후 200 { locked:false, result, winner, unlockedForBuyerId },
 * 미정산/미존재 403 { locked:true, reason }. 그 외는 예외.
 */
export async function fetchResult(auctionId) {
  const res = await fetch(`/slot/${auctionId}/result`, { cache: 'no-store' });
  if (res.status === 403) return res.json(); // { locked:true, ... }
  if (!res.ok) throw new Error(`result ${res.status}`);
  return res.json();
}

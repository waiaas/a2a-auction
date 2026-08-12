/**
 * 오케스트레이터(:4000) 얇은 클라이언트. 프론트는 상대경로만 쓴다(dev=Vite proxy, prod=정적 서빙 동일 오리진).
 * 폴링은 App이 1초 간격으로 fetchState()를 호출한다.
 */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Owner relay 토큰. 공개 배포본은 오케스트레이터가 `OWNER_TOKEN`을 요구한다 — 루프백
 * 바인딩이 없어지면 승인 대기 건 거부가 무인증으로 인터넷에 열리기 때문이다(감사 F2).
 * 최초 진입 시 `?t=<토큰>`으로 받아 sessionStorage에 옮기고 주소창에서는 지운다(녹화 노출 감소).
 * 로컬 실행은 토큰이 없어도 그대로 동작한다.
 */
const OWNER_TOKEN_KEY = 'a2a.ownerToken';

function ownerToken() {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('t');
    if (fromUrl) {
      sessionStorage.setItem(OWNER_TOKEN_KEY, fromUrl);
      url.searchParams.delete('t');
      window.history.replaceState({}, '', url.toString());
      return fromUrl;
    }
    return sessionStorage.getItem(OWNER_TOKEN_KEY) || '';
  } catch {
    return ''; // sessionStorage 차단 환경 — 토큰 없이 보내고 401을 그대로 표면화한다
  }
}

/** owner 라우트 전용 헤더. 토큰이 없으면 헤더를 붙이지 않는다(로컬 경로 무영향). */
function ownerHeaders(extra = {}) {
  const t = ownerToken();
  return t ? { ...extra, 'x-owner-token': t } : extra;
}

// ---- 구매 라운드 (콘티 v3) ----

export async function fetchPurchaseState() {
  const res = await fetch('/api/purchase/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`purchase state ${res.status}`);
  return res.json();
}

export async function fetchCatalog() {
  const res = await fetch('/api/purchase/catalog', { cache: 'no-store' });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  return res.json();
}

export async function startPurchase() {
  const res = await fetch('/api/purchase/start', { method: 'POST', headers: JSON_HEADERS });
  if (!res.ok) throw new Error(`purchase start ${res.status}`);
  return res.json();
}

export async function settlePurchase() {
  const res = await fetch('/api/purchase/settle', { method: 'POST', headers: JSON_HEADERS });
  if (!res.ok) throw new Error(`purchase settle ${res.status}`);
  return res.json();
}

/** 승인 대기 건 승인(컷 5). owner relay와 같은 토큰 규약을 쓴다. */
export async function approvePurchase(requestId) {
  const res = await fetch(`/api/purchase/approve/${requestId}`, {
    method: 'POST',
    headers: ownerHeaders(JSON_HEADERS),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `승인 실패 (${res.status})`);
  }
  return res.json();
}

export async function resetPurchase() {
  const res = await fetch('/api/purchase/reset', { method: 'POST', headers: JSON_HEADERS });
  if (!res.ok) throw new Error(`purchase reset ${res.status}`);
  return res.json();
}

export async function fetchState() {
  const res = await fetch('/api/auction/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json();
}

/** 판매자 콘솔의 경매 오픈. 이미 열렸거나 실행 중이면 409(무시). */
export async function openAuction() {
  const res = await fetch('/api/auction/open', { method: 'POST', headers: JSON_HEADERS });
  if (res.status === 409) return { alreadyOpen: true };
  if (!res.ok) throw new Error(`open ${res.status}`);
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

/** Owner 콘솔: B(Growth)의 승인 대기 큐 + 위임 한도. 데몬 불달 시 502. */
export async function fetchOwnerPending() {
  const res = await fetch('/api/owner/pending', { cache: 'no-store', headers: ownerHeaders() });
  if (!res.ok) throw new Error(`owner pending ${res.status}`);
  return res.json();
}

/** Owner 콘솔: 대기 tx 거부(데몬 어드민 relay). 성공 시 { id, status:'CANCELLED' }. */
export async function rejectOwnerTx(txId) {
  const res = await fetch(`/api/owner/reject/${txId}`, { method: 'POST', headers: ownerHeaders(JSON_HEADERS) });
  if (!res.ok) throw new Error(`reject ${res.status}`);
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

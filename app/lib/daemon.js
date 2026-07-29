/**
 * WAIaaS 데몬 HTTP 클라이언트. 데몬 내부는 수정하지 않고 REST로만 사용한다(스펙 5.3).
 *
 * 인증 두 갈래:
 *  - 지갑/정책/owner 관리: X-Master-Password 헤더 (부트스트랩 권한)
 *  - 트랜잭션 전송/조회: Authorization: Bearer <sessionToken>
 *
 * 호출 형태는 D-6 스파이크(run.cjs)에서 온체인으로 검증된 것을 그대로 따른다.
 */
import { NETWORK } from '../config.js';

async function http(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 한 데몬(에이전트)에 대한 클라이언트.
 * @param {{daemonUrl:string, walletId:string, sessionToken:string}} wallet - demo-state.json 항목
 * @param {string} masterPassword - infra/.env의 해당 role 마스터 패스워드
 */
export function daemonClient(wallet, masterPassword) {
  const base = wallet.daemonUrl;
  const mpwHdr = { 'X-Master-Password': masterPassword };
  const authHdr = { Authorization: `Bearer ${wallet.sessionToken}` };

  return {
    base,
    walletId: wallet.walletId,

    async health() {
      const r = await http('GET', `${base}/health`);
      return r.status === 200;
    },

    // ---- 정책 (X-Master-Password) ----
    async listPolicies() {
      const r = await http('GET', `${base}/v1/policies?walletId=${wallet.walletId}`, mpwHdr);
      return r.json.data || r.json.policies || r.json || [];
    },
    async createPolicy(type, rules, priority = 0) {
      const r = await http('POST', `${base}/v1/policies`, mpwHdr, {
        walletId: wallet.walletId,
        type,
        rules,
        priority,
        enabled: true,
      });
      if (r.status >= 300) throw new Error(`policy ${type} 생성 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json.id;
    },
    async updatePolicy(id, rules) {
      const r = await http('PUT', `${base}/v1/policies/${id}`, mpwHdr, { rules });
      if (r.status >= 300) throw new Error(`policy ${id} 갱신 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json;
    },
    async deletePolicy(id) {
      const r = await http('DELETE', `${base}/v1/policies/${id}`, mpwHdr);
      if (r.status >= 300) throw new Error(`policy ${id} 삭제 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return true;
    },

    // ---- owner (X-Master-Password로 등록, 서명 헤더로 verify) ----
    async registerOwner(ownerAddress) {
      const r = await http('PUT', `${base}/v1/wallets/${wallet.walletId}/owner`, mpwHdr, {
        owner_address: ownerAddress,
        approval_method: 'rest',
      });
      if (r.status >= 300) throw new Error(`owner 등록 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json;
    },
    async verifyOwner(ownerAddress, message, signatureB64) {
      const r = await http('POST', `${base}/v1/wallets/${wallet.walletId}/owner/verify`, {
        'X-Owner-Signature': signatureB64,
        'X-Owner-Message': message,
        'X-Owner-Address': ownerAddress,
      });
      if (r.status >= 300) throw new Error(`owner verify 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json; // { ownerState, ownerVerified }
    },
    async getWallet() {
      const r = await http('GET', `${base}/v1/wallets/${wallet.walletId}`, mpwHdr);
      return r.json;
    },

    // ---- 트랜잭션 (Bearer 세션) ----
    async sendTx(body) {
      const r = await http('POST', `${base}/v1/transactions/send`, authHdr, {
        walletId: wallet.walletId,
        network: NETWORK,
        ...body,
      });
      if (r.status >= 300) throw new Error(`send 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json.id;
    },
    async getTx(id) {
      const r = await http('GET', `${base}/v1/transactions/${id}`, authHdr);
      return r.json;
    },
    /**
     * 정지 상태(stopStatuses) 도달까지 폴링.
     *
     * 반환값에 `timedOut`을 실어 호출자가 **정책 판정과 관측 실패를 구분**할 수 있게 한다.
     * 이게 없으면 느린 네트워크에서 중간 상태 스냅샷이 그대로 흘러가 정책 거부처럼 보인다.
     */
    async pollTx(id, stopStatuses, timeoutMs = 45000) {
      const deadline = Date.now() + timeoutMs;
      let last = {};
      while (Date.now() < deadline) {
        last = await this.getTx(id);
        if (last && stopStatuses.includes(last.status)) return { ...last, timedOut: false };
        await sleep(1500);
      }
      return { ...last, timedOut: true };
    },
    async pendingTxIds() {
      const r = await http('GET', `${base}/v1/transactions/pending`, authHdr);
      const list = r.json.items || r.json.data || r.json.transactions || r.json || [];
      return Array.isArray(list) ? list.map((t) => t.id) : [];
    },
  };
}

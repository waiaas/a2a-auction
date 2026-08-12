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
    /**
     * x402 자동 결제 프록시. 402를 받으면 데몬이 정책 평가 후 결제하고 재요청한다.
     * 응답의 `payment`는 402를 실제로 거쳤을 때만 실린다(passthrough 200이면 없다).
     */
    async x402Fetch(url, method = 'GET') {
      const r = await http('POST', `${base}/v1/x402/fetch`, authHdr, {
        walletId: wallet.walletId,
        url,
        method,
      });
      if (r.status >= 300) throw new Error(`x402 fetch 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json; // { status, headers, body, payment? }
    },

    async pendingTxIds() {
      return (await this.pendingTxs()).map((t) => t.id);
    },

    /**
     * 승인 대기 큐 전체(owner 콘솔 표시용 상세 포함).
     * status를 검사하지 않으면 401 응답 본문이 빈 배열로 접혀 "큐가 비었다"로 오판된다
     * (3차 감사 — seed의 큐 정리가 토큰 무효 시 경고 없이 스킵되던 원인).
     */
    async pendingTxs() {
      const r = await http('GET', `${base}/v1/transactions/pending`, authHdr);
      if (r.status >= 300) throw new Error(`pending 조회 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      const list = r.json.items || r.json.data || r.json.transactions || r.json || [];
      return Array.isArray(list) ? list : [];
    },

    /**
     * 승인 대기 tx 거부. 어드민 경로(X-Master-Password)를 쓴다 —
     * owner 서명 경로(/v1/transactions/:id/reject)는 owner 키가 필요한데
     * 시드가 키를 보존하지 않기로 결정했다(kill-switch까지 열리는 과잉 권한).
     */
    async adminRejectTx(id) {
      const r = await http('POST', `${base}/v1/admin/transactions/${id}/reject`, mpwHdr);
      if (r.status >= 300) throw new Error(`tx ${id} 거부 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json; // { id, status: 'CANCELLED', rejectedAt }
    },

    /**
     * 승인 대기 tx 승인. **owner 서명이 유일한 경로다** — 거부와 달리 어드민 우회가 없다
     * (`/v1/admin/transactions/{id}/approve`는 존재하지 않는다). 그래서 시드가 owner 키를
     * 보존한다. 익스텐션 승인 경로가 준비되면 서명만 지갑에서 받아 이 호출로 중계하면 된다.
     */
    async approveTx(txId, ownerAddress, message, signatureB64) {
      // 세션 토큰과 owner 서명을 **둘 다** 요구한다(실측: 서명만 보내면 401 INVALID_TOKEN).
      // 세션은 "누가 이 지갑을 쓰는가", owner 서명은 "사람이 이 건을 허락했는가"로 층이 다르다.
      const r = await http('POST', `${base}/v1/transactions/${txId}/approve`, {
        ...authHdr,
        'X-Owner-Signature': signatureB64,
        'X-Owner-Message': message,
        'X-Owner-Address': ownerAddress,
      }, {});
      if (r.status >= 300) throw new Error(`tx ${txId} 승인 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json;
    },

    /**
     * 유예(DELAY) tx 취소. **승인 거부와 경로가 다르다** — DELAY는 승인 요청이 아니라
     * 유예 큐 대기라 `adminRejectTx`를 쓰면 `APPROVAL_NOT_FOUND`(404)로 실패한다(실측).
     * 이 구분을 놓치면 DELAY 건이 큐에 계속 남고, 남은 대기 건은 이후 판정을 전부
     * APPROVAL로 밀어올려 데모의 티어 대조를 무너뜨린다.
     */
    async cancelDelayedTx(id) {
      const r = await http('POST', `${base}/v1/transactions/${id}/cancel`, authHdr, {});
      if (r.status >= 300) throw new Error(`tx ${id} 유예 취소 실패 ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json; // { id, status: 'CANCELLED' }
    },
  };
}

#!/bin/bash
# D-5 완료 판정: curl로 전 플로우 완주.
# 오케스트레이터(4000) + seller(4100)가 떠 있어야 한다. Bash 도구는 dangerouslyDisableSandbox 필요.
#
#   1) 헬스체크
#   2) seller 게이트 — 존재하지 않는 auction(auction_not_found 분기) 403
#   3) POST /api/auction/start → /state 폴링 → settled 대기
#      + 정산 전 매 폴링마다 seller 감시(not_settled 분기) — 200이 한 번이라도 나오면 실패
#   4) GET /api/receipt (증거 체인)
#   5) 낙찰 auction seller 조회 → 200 unlock + hash·winner를 receipt와 교차 대조
#   6) 3분기(A ALLOW / B APPROVAL / C DENY) + B 승인 큐 등재 + 온체인 Settled·winner=A + vault 소진
#   7) X402_UNLOCK=1일 때만 — receipt의 x402 결제 증거 + 그 signature의 온체인 확정 + 재조회 재결제 없음
set -uo pipefail

ORCH=${ORCH:-http://127.0.0.1:4000}
SELLER=${SELLER:-http://127.0.0.1:4100}
command -v jq >/dev/null || { echo "ERROR: jq 필요"; exit 1; }

fail() { echo "❌ FAIL: $1"; exit 1; }

echo "=== [1] 헬스체크 ==="
curl -sf --max-time 5 "$ORCH/health" >/dev/null || fail "orchestrator 응답 없음 ($ORCH)"
curl -sf --max-time 5 "$SELLER/health" >/dev/null || fail "seller 응답 없음 ($SELLER)"
echo "orchestrator + seller OK"

echo ""
echo "=== [2] seller 게이트: 존재하지 않는 auction (auction_not_found 분기) ==="
GATE_BODY=$(curl -s --max-time 5 -w '\n%{http_code}' "$SELLER/slot/999999/result")
GATE=$(echo "$GATE_BODY" | tail -1)
GATE_REASON=$(echo "$GATE_BODY" | sed '$d' | jq -r '.reason // empty')
[ "$GATE" = "403" ] || fail "존재하지 않는 auction이 403이 아님 (got $GATE)"
[ "$GATE_REASON" = "auction_not_found" ] || fail "예상과 다른 분기 (reason=$GATE_REASON)"
echo "auction 999999 → 403 auction_not_found ✅"
echo "  (데모가 주장하는 '정산 전 잠김'은 not_settled 분기 — [3b]에서 라운드 중 검사한다)"

echo ""
echo "=== [3] 라운드 시작 ==="
curl -s --max-time 5 -X POST "$ORCH/api/auction/reset" >/dev/null
START=$(curl -s --max-time 10 -X POST "$ORCH/api/auction/start")
echo "$START" | jq -e '.started == true' >/dev/null || fail "start 실패: $START"
echo "start OK"

echo ""
echo "=== [3b] settled 대기 (최대 120s 폴링) + 정산 전 seller 게이트 감시 ==="
AUCTION_ID=""
MID_PROBES=0
MID_NOT_SETTLED=0
for i in $(seq 1 60); do
  S=$(curl -s --max-time 5 "$ORCH/api/auction/state")
  PHASE=$(echo "$S" | jq -r '.phase')
  AID=$(echo "$S" | jq -r '.auctionId // empty')
  # 정산 전에는 매 폴링마다 seller를 찔러 잠김을 확인한다.
  # 1회 샘플링으로는 게이트가 망가져도 놓칠 수 있어, 관측 전부가 403이어야 통과시킨다.
  #
  # settling은 제외한다: settle tx가 체인에 확정된 순간부터 auction은 Settled이지만
  # 오케스트레이터는 후처리(잔고 조회·결과 생성) 동안 phase='settling'에 머문다.
  # seller는 오케스트레이터 상태가 아니라 체인을 직접 읽으므로 이 구간의 200은 정상이다.
  if [ -n "$AID" ] && { [ "$PHASE" = "committing" ] || [ "$PHASE" = "depositing" ] || [ "$PHASE" = "revealing" ]; }; then
    MID_BODY=$(curl -s --max-time 5 -w '\n%{http_code}' "$SELLER/slot/$AID/result")
    MID_CODE=$(echo "$MID_BODY" | tail -1)
    MID_REASON=$(echo "$MID_BODY" | sed '$d' | jq -r '.reason // empty')
    MID_PROBES=$((MID_PROBES + 1))
    [ "$MID_CODE" = "403" ] || fail "정산 전 seller가 열렸다 (auction=$AID phase=$PHASE http=$MID_CODE)"
    [ "$MID_REASON" = "not_settled" ] && MID_NOT_SETTLED=$((MID_NOT_SETTLED + 1))
  fi
  echo "  [$i] phase=$PHASE"
  if [ "$PHASE" = "settled" ]; then AUCTION_ID="$AID"; break; fi
  if [ "$PHASE" = "error" ]; then fail "flow error: $(echo "$S" | jq -r '.error')"; fi
  sleep 2
done
[ -n "$AUCTION_ID" ] || fail "settled 도달 실패(타임아웃)"
# not_settled를 한 번도 못 봤다면 계정 생성 전(auction_not_found)만 본 것이라 게이트 검증이 안 된 상태다.
[ "$MID_NOT_SETTLED" -gt 0 ] || fail "정산 전 게이트의 not_settled 분기를 한 번도 관측하지 못함 — 게이트 미검증"
echo "정산 전 게이트: 프로브 ${MID_PROBES}회 전부 403, 그중 not_settled ${MID_NOT_SETTLED}회 ✅"
echo "settled (auction_id=$AUCTION_ID)"

echo ""
echo "=== [4] receipt ==="
R=$(curl -s --max-time 5 "$ORCH/api/receipt")
echo "$R" | jq '{auctionId, winnerBuyerId, createAuctionTx, revealTx, settleTx, settlement, resultHash, resultSource, depositDecisions: [.depositDecisions[] | {buyer, decision, tier, status}]}'

echo ""
echo "=== [5] seller unlock (정산 후 200) ==="
UNLOCK=$(curl -s --max-time 10 "$SELLER/slot/$AUCTION_ID/result")
echo "$UNLOCK" | jq -e '.locked == false' >/dev/null || fail "정산 후에도 unlock 안 됨: $(echo "$UNLOCK" | jq -c '{locked,reason,status}')"
WINNER_FOR=$(echo "$UNLOCK" | jq -r '.unlockedForBuyerId')
UNLOCK_HASH=$(echo "$UNLOCK" | jq -r '.result.hash // empty')
RECEIPT_HASH=$(echo "$R" | jq -r '.resultHash // empty')
UNLOCK_WINNER=$(echo "$UNLOCK" | jq -r '.winner // empty')
RECEIPT_WINNER=$(echo "$R" | jq -r '.onchainAuction.winner // empty')

# seller와 오케스트레이터는 서로를 믿지 않고 각자 체인을 읽는다. 두 결과가 같아야 증거 체인이 성립한다.
[ -n "$UNLOCK_HASH" ] || fail "unlock 응답에 result.hash 없음"
[ "$UNLOCK_HASH" = "$RECEIPT_HASH" ] || fail "결과물 hash 불일치: seller=$UNLOCK_HASH receipt=$RECEIPT_HASH"
[ -n "$UNLOCK_WINNER" ] || fail "unlock 응답에 winner 없음"
[ "$UNLOCK_WINNER" = "$RECEIPT_WINNER" ] || fail "winner 불일치: seller=$UNLOCK_WINNER orchestrator=$RECEIPT_WINNER"
[ "$WINNER_FOR" = "buyer-a" ] || fail "seller가 체인에서 대조한 낙찰자가 buyer-a 아님 ($WINNER_FOR)"
echo "unlock OK → unlockedFor=$WINNER_FOR, hash=$(echo "$UNLOCK_HASH" | cut -c1-16)… (receipt와 일치 ✅, winner 교차 대조 ✅)"

echo ""
echo "=== [6] 3분기 + 온체인 판정 ==="
A_UI=$(echo "$R" | jq -r '.depositDecisions[] | select(.buyer=="buyer-a") | .decision')
B_UI=$(echo "$R" | jq -r '.depositDecisions[] | select(.buyer=="buyer-b") | .decision')
C_UI=$(echo "$R" | jq -r '.depositDecisions[] | select(.buyer=="buyer-c") | .decision')
B_PENDING=$(echo "$R" | jq -r '.depositDecisions[] | select(.buyer=="buyer-b") | .inPending')
STATUS=$(echo "$R" | jq -r '.onchainAuction.status')
WINNER_IS_A=$(echo "$R" | jq -r '.onchainAuction.winnerIsA')
SELLER_USDC=$(echo "$R" | jq -r '.settlement.sellerUsdc')
VAULT_USDC=$(echo "$R" | jq -r '.settlement.vaultUsdc')

echo "  A=$A_UI  B=$B_UI(큐 등재 $B_PENDING)  C=$C_UI  | auction=$STATUS winnerIsA=$WINNER_IS_A sellerUsdc=$SELLER_USDC vault=$VAULT_USDC"
[ "$A_UI" = "ALLOW" ] || fail "A가 ALLOW 아님 ($A_UI)"
[ "$B_UI" = "APPROVAL_REQUIRED" ] || fail "B가 APPROVAL_REQUIRED 아님 ($B_UI)"
[ "$C_UI" = "DENY" ] || fail "C가 DENY 아님 ($C_UI)"
# README가 실물 증거로 내세우는 항목 — 데몬의 승인 대기 큐에 B의 tx가 실제로 있는지
# null = 라운드 중 큐 조회 자체가 실패한 것(관측 실패). false(큐에 없음 = 정책 경로 문제)와
# 다른 사건이므로 문구를 가른다 — TIMEOUT/timedOut과 같은 구분 원칙.
if [ "$B_PENDING" = "null" ]; then
  fail "B 승인 큐 관측 실패 (라운드 중 데몬 조회 실패 — 정책 실패 아님, 데몬 상태 확인 후 재실행)"
fi
[ "$B_PENDING" = "true" ] || fail "B의 예치가 승인 대기 큐에 없음 (inPending=$B_PENDING)"
[ "$STATUS" = "Settled" ] || fail "auction이 Settled 아님 ($STATUS)"
[ "$WINNER_IS_A" = "true" ] || fail "winner가 A 아님"
# 정산 후 vault는 비어야 한다(낙찰액 전부 seller로). 남으면 잠긴 예치금이 있다는 뜻.
[ "$VAULT_USDC" = "0" ] || fail "정산 후 vault가 비지 않음 ($VAULT_USDC)"

if [ "${X402_UNLOCK:-}" = "1" ]; then
  echo ""
  echo "=== [7] x402 결과물 unlock (X402_UNLOCK=1) ==="
  # ① receipt에 결제 증거가 있는가.
  #    "정산 후 첫 요청이 402"는 사후 관측이 불가능하다 — flow가 settled 전에 결제를 끝내므로
  #    스크립트 시점의 seller는 항상 캐시된 200이다. 대신 데몬 응답에 payment가 실렸다는 사실
  #    (= 402를 거쳐 결제했다는 증거)을 flow가 receipt에 실어두고 여기서 검사한다.
  X_AMOUNT=$(echo "$R" | jq -r '.x402.amountUsdc // empty')
  X_TXID=$(echo "$R" | jq -r '.x402.daemonTxId // empty')
  X_SIG=$(echo "$R" | jq -r '.x402.onchainSignature // empty')
  [ -n "$X_AMOUNT" ] || fail "receipt에 x402 결제 증거 없음 (402를 거치지 않았다)"
  [ "$X_AMOUNT" = "0.05" ] || fail "x402 결제액이 0.05 USDC 아님 ($X_AMOUNT)"
  [ -n "$X_TXID" ] || fail "receipt에 데몬 x402 txId 없음"
  [ -n "$X_SIG" ] || fail "receipt에 온체인 signature 없음 (seller가 돌려주지 않았다)"
  echo "receipt: ${X_AMOUNT} USDC · 데몬 txId=$(echo "$X_TXID" | cut -c1-12)… · sig=$(echo "$X_SIG" | cut -c1-16)…"

  # ② 그 signature가 실제로 체인에 확정됐는가. 데몬은 이 값을 모른다(facilitator가 제출).
  X_STATUS=$(curl -s --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignatureStatuses\",\"params\":[[\"$X_SIG\"]]}" \
    "${RPC:-http://192.168.0.113:8899}" | jq -r '.result.value[0].confirmationStatus // empty')
  [ -n "$X_STATUS" ] || fail "x402 결제 signature가 체인에 없음 ($X_SIG)"
  echo "온체인 확인: $X_SIG → $X_STATUS ✅"

  # ③ 결제 완료 후 재조회가 재결제 없이 200인가(중복 결제 방어 = 결제 마커).
  RE=$(curl -s --max-time 10 -w '\n%{http_code}' "$SELLER/slot/$AUCTION_ID/result")
  RE_CODE=$(echo "$RE" | tail -1)
  RE_SIG=$(echo "$RE" | sed '$d' | jq -r '.payment.signature // empty')
  [ "$RE_CODE" = "200" ] || fail "결제 후 재조회가 200이 아님 (got $RE_CODE) — 결제 마커 미작동"
  [ "$RE_SIG" = "$X_SIG" ] || fail "재조회 signature 불일치: $RE_SIG != $X_SIG (재결제 발생)"
  echo "재조회 200 + 같은 signature (재결제 없음 ✅)"
  echo "  (정산 전 403 회귀 없음은 [3b]에서 이미 확인됨 — 프로브 ${MID_PROBES}회 전부 403)"
fi

echo ""
echo "✅ PASS — 3분기 판정(A 실행 / B 승인대기+큐 등재 / C 거부) · 정산 전 seller 잠김 ${MID_PROBES}회 관측"
echo "         · 온체인 Settled·winner=A · vault 소진 · seller↔orchestrator hash·winner 일치"
# 마지막 문장의 종료 코드가 스크립트 종료 코드가 되므로 if로 감싼다(false면 실패로 보인다).
if [ "${X402_UNLOCK:-}" = "1" ]; then
  echo "         · x402 unlock 0.05 USDC 온체인 확정 · 재조회 재결제 없음"
fi

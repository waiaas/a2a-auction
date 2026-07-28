#!/bin/bash
# D-5 완료 판정: curl로 전 플로우 완주.
# 오케스트레이터(4000) + seller(4100)가 떠 있어야 한다. Bash 도구는 dangerouslyDisableSandbox 필요.
#
#   1) 헬스체크
#   2) seller 게이트(미정산 403) 결정론적 증명 — 존재하지 않는 auction 조회
#   3) POST /api/auction/start → /state 폴링 → settled 대기
#   4) GET /api/receipt (증거 체인)
#   5) 낙찰 auction seller 조회 → 200 unlock 확인
#   6) 3분기(A ALLOW / B APPROVAL / C DENY) + 온체인 Settled·winner=A 판정
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
echo "=== [2] seller 게이트: 미정산 403 (결정론적) ==="
GATE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$SELLER/slot/999999/result")
[ "$GATE" = "403" ] || fail "미정산 auction이 403이 아님 (got $GATE)"
echo "존재하지 않는 auction 999999 → 403 (locked) ✅"

echo ""
echo "=== [3] 라운드 시작 ==="
curl -s --max-time 5 -X POST "$ORCH/api/auction/reset" >/dev/null
START=$(curl -s --max-time 10 -X POST "$ORCH/api/auction/start")
echo "$START" | jq -e '.started == true' >/dev/null || fail "start 실패: $START"
echo "start OK"

echo ""
echo "=== [3b] settled 대기 (최대 120s 폴링) ==="
AUCTION_ID=""
SELLER_MIDGATE=""
for i in $(seq 1 60); do
  S=$(curl -s --max-time 5 "$ORCH/api/auction/state")
  PHASE=$(echo "$S" | jq -r '.phase')
  AID=$(echo "$S" | jq -r '.auctionId // empty')
  # auction_id가 잡히고 아직 정산 전이면 seller 게이트가 403인지 한 번 확인(best-effort)
  if [ -n "$AID" ] && [ -z "$SELLER_MIDGATE" ] && [ "$PHASE" != "settled" ]; then
    MID=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$SELLER/slot/$AID/result")
    SELLER_MIDGATE="$MID"
    echo "  auction_id=$AID phase=$PHASE → seller(정산 전) HTTP $MID"
  fi
  echo "  [$i] phase=$PHASE"
  if [ "$PHASE" = "settled" ]; then AUCTION_ID="$AID"; break; fi
  if [ "$PHASE" = "error" ]; then fail "flow error: $(echo "$S" | jq -r '.error')"; fi
  sleep 2
done
[ -n "$AUCTION_ID" ] || fail "settled 도달 실패(타임아웃)"
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
echo "unlock OK → unlockedFor=$WINNER_FOR, result.hash=$(echo "$UNLOCK" | jq -r '.result.hash' | cut -c1-16)…"

echo ""
echo "=== [6] 3분기 + 온체인 판정 ==="
A_UI=$(echo "$R" | jq -r '.depositDecisions[] | select(.buyer=="buyer-a") | .decision')
B_UI=$(echo "$R" | jq -r '.depositDecisions[] | select(.buyer=="buyer-b") | .decision')
C_UI=$(echo "$R" | jq -r '.depositDecisions[] | select(.buyer=="buyer-c") | .decision')
STATUS=$(echo "$R" | jq -r '.onchainAuction.status')
WINNER_IS_A=$(echo "$R" | jq -r '.onchainAuction.winnerIsA')
SELLER_USDC=$(echo "$R" | jq -r '.settlement.sellerUsdc')

echo "  A=$A_UI  B=$B_UI  C=$C_UI  | auction=$STATUS winnerIsA=$WINNER_IS_A sellerUsdc=$SELLER_USDC"
[ "$A_UI" = "ALLOW" ] || fail "A가 ALLOW 아님 ($A_UI)"
[ "$B_UI" = "APPROVAL_REQUIRED" ] || fail "B가 APPROVAL_REQUIRED 아님 ($B_UI)"
[ "$C_UI" = "DENY" ] || fail "C가 DENY 아님 ($C_UI)"
[ "$STATUS" = "Settled" ] || fail "auction이 Settled 아님 ($STATUS)"
[ "$WINNER_IS_A" = "true" ] || fail "winner가 A 아님"
[ "$SELLER_MIDGATE" = "403" ] || echo "  (주의) 정산 전 seller 게이트 관측값=$SELLER_MIDGATE (403 기대, 타이밍상 놓쳤을 수 있음)"

echo ""
echo "✅ PASS — curl 전 플로우 완주 (A 실행 / B 승인대기 / C 거부 · settle·unlock 완료 · A 낙찰)"

#!/bin/bash
# 데몬 5개에 지갑 생성 + 세션 발급 → demo-state.json 기록 (스펙 v3 §7.2).
# 인증: 지갑/세션 생성 = X-Master-Password 헤더 (infra/.env). 토큰은 파일에만 기록, 화면 미표시.
# 재실행 시 demo-state.json이 완전하면 스킵(멱등). 재생성하려면 demo-state.json 삭제 후 실행.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="$ROOT/infra/.env"
STATE="$ROOT/demo-state.json"

[ -f "$ENVF" ] || { echo "ERROR: infra/.env 없음"; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq 필요 (brew install jq)"; exit 1; }
set -a; source "$ENVF"; set +a

# role:hostPort:passwordVar
DAEMONS=(
  "buyer-a:3100:BUYER_A_MASTER_PASSWORD"
  "buyer-b:3101:BUYER_B_MASTER_PASSWORD"
  "buyer-c:3102:BUYER_C_MASTER_PASSWORD"
  "seller:3103:SELLER_MASTER_PASSWORD"
  "marketplace:3104:MARKETPLACE_MASTER_PASSWORD"
)

if [ -f "$STATE" ] && [ "$(jq 'length' "$STATE" 2>/dev/null || echo 0)" = "5" ]; then
  echo "demo-state.json 이미 완전(5개). 스킵. 재생성하려면 파일 삭제 후 재실행."
  jq -r '.[] | "[\(.role)] wallet=\(.walletId) addr=\(.address)"' "$STATE"
  exit 0
fi

echo "[]" > "$STATE.tmp"
for d in "${DAEMONS[@]}"; do
  IFS=: read -r role port pwvar <<< "$d"
  pw="${!pwvar}"
  base="http://127.0.0.1:$port"

  curl -sf --max-time 5 "$base/health" >/dev/null || { echo "ERROR: [$role] health 실패 ($base)"; exit 1; }

  # Solana devnet = chain:solana + environment:testnet (enum은 testnet|mainnet만 허용, 데몬이 solana-devnet으로 매핑)
  wres=$(curl -s -X POST "$base/v1/wallets" \
    -H "X-Master-Password: $pw" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$role\",\"chain\":\"solana\",\"environment\":\"testnet\",\"createSession\":false}")
  wid=$(echo "$wres" | jq -r '.id // .wallet.id // .walletId // empty')
  addr=$(echo "$wres" | jq -r '.publicKey // .address // .wallet.publicKey // empty')
  net=$(echo "$wres" | jq -r '.network // .wallet.network // .environment // empty')
  if [ -z "$wid" ] || [ -z "$addr" ]; then
    echo "ERROR: [$role] 지갑 생성 응답 파싱 실패. 원본 응답:"; echo "$wres" | jq . 2>/dev/null || echo "$wres"; exit 1
  fi

  sres=$(curl -s -X POST "$base/v1/sessions" \
    -H "X-Master-Password: $pw" -H 'Content-Type: application/json' \
    -d "{\"walletId\":\"$wid\"}")
  tok=$(echo "$sres" | jq -r '.token // empty')
  if [ -z "$tok" ]; then
    echo "ERROR: [$role] 세션 발급 응답 파싱 실패. 원본 응답:"; echo "$sres" | jq . 2>/dev/null || echo "$sres"; exit 1
  fi

  jq --arg role "$role" --argjson port "$port" --arg base "$base" \
     --arg wid "$wid" --arg addr "$addr" --arg net "$net" --arg tok "$tok" \
     '. += [{role:$role, port:$port, daemonUrl:$base, walletId:$wid, address:$addr, network:$net, sessionToken:$tok}]' \
     "$STATE.tmp" > "$STATE.tmp2" && mv "$STATE.tmp2" "$STATE.tmp"
  echo "[$role] wallet=$wid  addr=$addr  net=$net  session=OK"
done
mv "$STATE.tmp" "$STATE"
chmod 600 "$STATE"
echo ""
echo "완료 → $STATE (주소만 표시, 세션 토큰은 파일에만 저장)"
echo "--- devnet 지갑 주소 5개 (faucet USDC 분배용) ---"
jq -r '.[] | "\(.role): \(.address)"' "$STATE"

#!/bin/bash
# 3분기 온체인 실측 실행 래퍼.
# @solana/web3.js + @solana/spl-token 을 WAIaaS pnpm 스토어에서 NODE_PATH로 노출한다.
# 반드시 Bash 도구의 dangerouslyDisableSandbox:true 로 실행할 것(루프백/LAN RPC 차단 회피).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WAIAAS_NM="/Users/pc-25-008/Documents/GitHub/waiaas-workspace/WAIaaS/node_modules/.pnpm"

# spl-token@0.4.14 + web3.js@1.98.4 조합 디렉터리(둘 다 이 node_modules에 심링크됨)
SPL_DIR="$(ls -d "$WAIAAS_NM"/@solana+spl-token@0.4.14_@solana+web3.js@1.98.4_*/node_modules 2>/dev/null | head -1)"
if [ -z "${SPL_DIR:-}" ]; then
  echo "ERROR: @solana/spl-token(0.4.14/web3.js1.98.4) node_modules를 찾지 못함"; exit 1
fi

export NODE_PATH="$SPL_DIR"
exec node "$HERE/run.cjs"

#!/usr/bin/env bash
# Local validator with Metaplex Token Metadata cloned from mainnet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER="$ROOT/.local-validator"
export PATH="${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

exec solana-test-validator \
  --ledger "$LEDGER" \
  --reset \
  --quiet \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA

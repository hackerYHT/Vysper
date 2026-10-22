#!/usr/bin/env bash
# Download Whisper ggml model for local STT
# Usage: ./scripts/download-whisper-model.sh [small|medium|large-v3]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIZE="${1:-medium}"
mkdir -p "$ROOT/models"
OUT="$ROOT/models/ggml-${SIZE}.bin"
URL="${WHISPER_MODEL_URL:-https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-${SIZE}.bin}"

if [[ -f "$OUT" ]]; then
  echo "Model already exists: $OUT"
  ls -lh "$OUT"
  exit 0
fi

echo "Downloading $SIZE model from $URL ..."
echo "(medium ≈ 1.5GB — better CN+EN tech terms than small)"
curl -L --fail --progress-bar -o "$OUT.partial" "$URL"
mv "$OUT.partial" "$OUT"
ls -lh "$OUT"
echo "Done. App prefers ggml-medium.bin automatically when present."
echo "Or set WHISPER_MODEL_PATH=$OUT in .env"

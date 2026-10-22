#!/usr/bin/env bash
# Download Whisper ggml-small for local Chinese STT
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/models"
OUT="$ROOT/models/ggml-small.bin"
URL="${WHISPER_MODEL_URL:-https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin}"

if [[ -f "$OUT" ]]; then
  echo "Model already exists: $OUT"
  ls -lh "$OUT"
  exit 0
fi

echo "Downloading $URL ..."
curl -L --fail --progress-bar -o "$OUT" "$URL"
ls -lh "$OUT"
echo "Done. Set SPEECH_PROVIDER=local in .env"

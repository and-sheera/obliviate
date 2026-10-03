#!/usr/bin/env bash
# One-off: fetch the NER model from Hugging Face and put a quantized ONNX build into public/models/ner.
# The result is committed, so the app never talks to huggingface.co at runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL="${1:-r1char9/ner-rubert-tiny-news}"
OUT="${2:-public/models/ner}"

[ -d .venv-model ] || python3 -m venv .venv-model
. .venv-model/bin/activate
python -c "import torch, transformers, onnx, onnxruntime" 2>/dev/null ||
  pip install -q torch transformers onnx onnxruntime

python scripts/convert_model.py "$MODEL" "$OUT"
du -sh "$OUT"

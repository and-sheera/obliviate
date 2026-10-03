"""HF token-classification model -> quantized ONNX in the layout transformers.js expects.

usage: convert_model.py <hf-model-id> <out-dir>
"""
import pathlib
import sys
import tempfile

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForTokenClassification, AutoTokenizer

model_id, out = sys.argv[1], pathlib.Path(sys.argv[2])
tok = AutoTokenizer.from_pretrained(model_id)
model = AutoModelForTokenClassification.from_pretrained(model_id).eval()
# drop embedding rows the tokenizer never emits (distilrubert-conversational: 119547 rows, 100792 tokens, -14 MB)
model.resize_token_embeddings(len(tok))

(out / "onnx").mkdir(parents=True, exist_ok=True)
tok.save_pretrained(out)
model.config.save_pretrained(out)

enc = tok("Иван Петров работает в Сбербанке", return_tensors="pt")
names = [k for k in ("input_ids", "attention_mask", "token_type_ids") if k in enc]
axes = {n: {0: "batch", 1: "seq"} for n in names + ["logits"]}

with tempfile.TemporaryDirectory() as tmp:
    fp32 = pathlib.Path(tmp) / "model.onnx"
    torch.onnx.export(
        model, tuple(enc[k] for k in names), str(fp32),
        input_names=names, output_names=["logits"], dynamic_axes=axes,
        opset_version=17, dynamo=False,
    )
    quantize_dynamic(str(fp32), str(out / "onnx" / "model_quantized.onnx"), weight_type=QuantType.QUInt8)

print("ok:", sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file()))

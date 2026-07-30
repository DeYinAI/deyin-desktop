#!/usr/bin/env python3
"""
Fine-tune Qwen3-Embedding-0.6B into DeYinAI Embedding for code/tool similarity.

Produces an ONNX int8 model for packages/optimization-plugin/models/deyinai-embedding.onnx.

Usage:
  pip install -r scripts/requirements-embedding.txt
  python scripts/fine-tune-embedding.py --data scripts/embedding-data --out packages/optimization-plugin/models

Requires GPU for reasonable fine-tune time; CPU works for tiny smoke runs.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

BASE_MODEL = "Qwen/Qwen3-Embedding-0.6B"
OUTPUT_NAME = "deyinai-embedding"


def load_pairs(data_dir: Path) -> list[dict]:
    pairs_path = data_dir / "pairs.jsonl"
    if not pairs_path.exists():
        raise SystemExit(f"Missing training pairs at {pairs_path}")
    pairs = []
    with pairs_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if "query" in row and "positive" in row:
                pairs.append(row)
    if not pairs:
        raise SystemExit("No training pairs found")
    return pairs


def build_dataset(pairs: list[dict]):
    from datasets import Dataset

    queries = [p["query"] for p in pairs]
    positives = [p["positive"] for p in pairs]
    # Hard negatives: shuffle positives so each query gets an unrelated doc.
    negatives = positives[:]
    random.Random(42).shuffle(negatives)
    # Avoid accidental self-matches.
    for i, (pos, neg) in enumerate(zip(positives, negatives)):
        if pos == neg and len(positives) > 1:
            negatives[i] = positives[(i + 1) % len(positives)]
    return Dataset.from_dict(
        {
            "query": queries,
            "positive": positives,
            "negative": negatives,
        }
    )


def fine_tune(data_dir: Path, out_dir: Path, epochs: float, batch_size: int) -> Path:
    from sentence_transformers import SentenceTransformer, SentenceTransformerTrainer
    from sentence_transformers.losses import MultipleNegativesRankingLoss
    from sentence_transformers.training_args import SentenceTransformerTrainingArguments

    pairs = load_pairs(data_dir)
    dataset = build_dataset(pairs)
    print(f"Loaded {len(pairs)} pairs from {data_dir}")

    model = SentenceTransformer(BASE_MODEL)
    loss = MultipleNegativesRankingLoss(model)

    checkpoint_dir = out_dir / "checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    args = SentenceTransformerTrainingArguments(
        output_dir=str(checkpoint_dir),
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        learning_rate=2e-5,
        warmup_ratio=0.1,
        fp16=False,
        bf16=False,
        logging_steps=10,
        save_strategy="epoch",
        report_to=[],
    )

    trainer = SentenceTransformerTrainer(
        model=model,
        args=args,
        train_dataset=dataset,
        loss=loss,
    )
    trainer.train()

    hf_out = out_dir / OUTPUT_NAME
    model.save_pretrained(str(hf_out))
    print(f"Saved HuggingFace model to {hf_out}")
    return hf_out


def export_onnx(hf_dir: Path, out_dir: Path) -> Path:
    """Export via optimum if available; otherwise leave HF weights for transformers.js conversion."""
    onnx_path = out_dir / f"{OUTPUT_NAME}.onnx"
    try:
        from optimum.onnxruntime import ORTModelForFeatureExtraction
        from transformers import AutoTokenizer

        model = ORTModelForFeatureExtraction.from_pretrained(str(hf_dir), export=True)
        tokenizer = AutoTokenizer.from_pretrained(str(hf_dir))
        export_dir = out_dir / f"{OUTPUT_NAME}-onnx"
        export_dir.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(str(export_dir))
        tokenizer.save_pretrained(str(export_dir))

        # Prefer model.onnx if present.
        candidates = list(export_dir.glob("**/*.onnx"))
        if candidates:
            target = out_dir / f"{OUTPUT_NAME}.onnx"
            target.write_bytes(candidates[0].read_bytes())
            print(f"Exported ONNX to {target} ({target.stat().st_size / 1e6:.1f} MB)")
            return target
    except Exception as exc:  # noqa: BLE001
        print(f"ONNX export skipped ({exc}). HuggingFace weights remain at {hf_dir}")
        print("Convert later with: optimum-cli export onnx --model <hf_dir> --task feature-extraction <out>")
    return onnx_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Fine-tune DeYinAI Embedding from Qwen3-Embedding-0.6B")
    parser.add_argument("--data", type=Path, default=Path("scripts/embedding-data"))
    parser.add_argument("--out", type=Path, default=Path("packages/optimization-plugin/models"))
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--skip-train", action="store_true", help="Only export existing HF checkpoint")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    hf_dir = args.out / OUTPUT_NAME
    if not args.skip_train:
        hf_dir = fine_tune(args.data, args.out, args.epochs, args.batch_size)
    elif not hf_dir.exists():
        raise SystemExit(f"No checkpoint at {hf_dir}; run without --skip-train first")
    export_onnx(hf_dir, args.out)
    meta = {
        "name": "DeYinAI Embedding",
        "base_model": BASE_MODEL,
        "version": "0.1.0",
        "dimensions": 1024,
        "context_length": 32768,
        "description": "Fine-tuned Qwen3-Embedding-0.6B for Deyin code/tool semantic caching",
    }
    (args.out / "deyinai-embedding.meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print("Done. Ship models/deyinai-embedding.onnx with the optimization plugin.")


if __name__ == "__main__":
    main()

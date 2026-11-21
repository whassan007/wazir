#!/usr/bin/env python3
"""
scripts/train-wazir-shell-mini.py

Supervised Fine-Tuning (SFT / LoRA) pipeline for `wazir-shell-mini`
(based on `LiquidAI/LFM2.5-350M`) targeting Wazir Shell's 18-tool catalog.

Usage:
  1. Generate dataset:
       node scripts/generate-shell-training-dataset.mjs
  2. Validate dataset & ChatML tool-call schema locally:
       python3 scripts/train-wazir-shell-mini.py --validate-only
  3. Run LoRA SFT fine-tuning (requires torch, transformers, datasets, peft, trl):
       python3 scripts/train-wazir-shell-mini.py \
         --model-id LiquidAI/LFM2.5-350M \
         --dataset dist/training/wazir-shell-mini-sft.jsonl \
         --eval-dataset dist/training/wazir-shell-mini-eval.jsonl \
         --output-dir dist/training/wazir-shell-mini-lora \
         --epochs 3
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REQUIRED_TOKENS = ("<|startoftext|>", "<|im_start|>", "<|im_end|>", "<|tool_call_start|>", "<|tool_call_end|>")


def load_and_validate_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        raise FileNotFoundError(f"Dataset file not found: {path}")
    records: list[dict] = []
    for idx, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        text = obj.get("text")
        messages = obj.get("messages")
        if not isinstance(text, str) or not text:
            raise ValueError(f"{path}:{idx}: missing non-empty 'text' field")
        if not isinstance(messages, list) or len(messages) < 3:
            raise ValueError(f"{path}:{idx}: expected 'messages' array with system/user/assistant turns")
        for tok in REQUIRED_TOKENS:
            if tok not in text:
                raise ValueError(f"{path}:{idx}: missing required LFM2.5 token {tok}")
        records.append(obj)
    if not records:
        raise ValueError(f"Dataset {path} contains 0 records")
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description="Fine-tune LiquidAI/LFM2.5-350M for wazir-shell-mini tool routing")
    parser.add_argument("--model-id", default="LiquidAI/LFM2.5-350M", help="Base HuggingFace model ID or local path")
    parser.add_argument("--dataset", default="dist/training/wazir-shell-mini-sft.jsonl", help="Training JSONL path")
    parser.add_argument("--eval-dataset", default="dist/training/wazir-shell-mini-eval.jsonl", help="Eval JSONL path")
    parser.add_argument("--output-dir", default="dist/training/wazir-shell-mini-lora", help="Output adapter directory")
    parser.add_argument("--epochs", type=int, default=3, help="Number of SFT epochs")
    parser.add_argument("--batch-size", type=int, default=4, help="Per-device training batch size")
    parser.add_argument("--learning-rate", type=float, default=2e-4, help="LoRA AdamW learning rate")
    parser.add_argument("--max-seq-length", type=int, default=1024, help="Maximum sequence length")
    parser.add_argument("--lora-r", type=int, default=16, help="LoRA rank")
    parser.add_argument("--lora-alpha", type=int, default=32, help="LoRA alpha")
    parser.add_argument("--merge-and-save", action="store_true", help="Merge LoRA weights into base model for GGUF export")
    parser.add_argument("--validate-only", action="store_true", help="Validate datasets and configuration without running training")
    args = parser.parse_args()

    train_records = load_and_validate_jsonl(Path(args.dataset))
    eval_records = load_and_validate_jsonl(Path(args.eval_dataset))
    tools = sorted({r.get("tool", "unknown") for r in train_records + eval_records})

    print(f"[wazir-train] Verified {len(train_records)} train and {len(eval_records)} eval records across {len(tools)} tool classes.")
    if args.validate_only:
        print("[wazir-train] --validate-only complete. Ready for SFT training + GGUF Q4_K_M quantization.")
        return 0

    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from trl import SFTConfig, SFTTrainer
    except ImportError as exc:
        print(
            f"[wazir-train] Missing ML training dependency ({exc}).\n"
            "Install training extras in a dedicated Python environment:\n"
            "  pip install torch transformers datasets peft trl accelerate",
            file=sys.stderr,
        )
        return 1

    tokenizer = AutoTokenizer.from_pretrained(args.model_id)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        args.model_id,
        torch_dtype=dtype,
        device_map="auto" if torch.cuda.is_available() else None,
    )

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "out_proj", "w1", "w2", "w3"],
    )

    train_ds = Dataset.from_list([{"text": r["text"]} for r in train_records])
    eval_ds = Dataset.from_list([{"text": r["text"]} for r in eval_records])

    sft_config = SFTConfig(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        logging_steps=5,
        eval_strategy="epoch",
        save_strategy="epoch",
        max_length=args.max_seq_length,
        bf16=torch.cuda.is_available(),
    )

    trainer = SFTTrainer(
        model=model,
        args=sft_config,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        processing_class=tokenizer,
        peft_config=lora_config,
    )
    trainer.train()
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print(f"[wazir-train] Saved LoRA adapter to {args.output_dir}")

    if args.merge_and_save:
        merged_dir = Path(args.output_dir).with_name("wazir-shell-mini-merged")
        merged = trainer.model.merge_and_unload()
        merged.save_pretrained(merged_dir)
        tokenizer.save_pretrained(merged_dir)
        print(f"[wazir-train] Saved merged FP16/BF16 model to {merged_dir}")
        print(
            "Next: convert to GGUF & quantize with llama.cpp:\n"
            f"  python3 convert_hf_to_gguf.py {merged_dir} --outfile dist/training/wazir-shell-mini-f16.gguf --outtype f16\n"
            "  llama-quantize dist/training/wazir-shell-mini-f16.gguf assets/models/wazir-shell-mini/LFM2.5-350M-Q4_K_M.gguf Q4_K_M"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

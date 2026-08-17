# Semantic Optimization Plugin

Optional Deyin plugin that adds:

- **DeYinAI Embedding** — fine-tuned from Qwen3-Embedding-0.6B
- **Tool result cache** — semantic matching for redundant file/search/bash ops
- **Response cache** — JSON store for repeated queries

## Install

Built into the monorepo as `@deyin/optimization-plugin`. Desktop loads it when
Settings → Optimization → Semantic plugin is enabled.

## Model

```bash
pip install -r scripts/requirements-embedding.txt
python scripts/fine-tune-embedding.py
```

Place `deyinai-embedding.onnx` in `models/`. Until then the plugin uses a fast
hash embedder (same family as the local code indexer) so caching still works offline.

## Disable

Toggle off in Settings, or uninstall — core compression / prompt caching remain.

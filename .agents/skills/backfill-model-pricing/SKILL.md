---
name: backfill-model-pricing
description: Use when the human asks to write or rewrite `usage.cost_json` for
  some slice of usage rows — typically backfilling NULL rows, or overwriting a
  time range after a price change. Operates on a live D1 environment, defaults
  to production.
---

# Backfill Model Pricing

`usage.cost_json` is the per-row pricing snapshot (migration 0011). This skill
rewrites it for a chosen slice using the current provider pricing.

## Flow

1. **Pick the environment.** Default `--remote` (production). Announce which
   one before any write.

2. **Get intent.** Need: target model(s), owning upstream, time window on
   `usage.hour`, and write mode (fill-NULL-only vs overwrite). If the human
   gives an explicit time, make them name the timezone — `usage.hour` is a
   text bucket and `hour` strings are ambiguous on their own. Ask for
   whatever is missing; do not guess the model or upstream.

3. **If the human gave no instruction**, show them the menu: enabled
   upstreams, and `(upstream, model_key)` aggregates over rows with
   `cost_json IS NULL` including count and `MIN/MAX(hour)`. Let them pick a
   slice from that.

4. **Resolve pricing per `(upstream, model_key)`** by reading the provider's
   own pricing source — TS code under `src/data-plane/providers/<provider>/`
   or the upstream's `config` JSON in `upstreams`. Different provider kinds
   resolve differently; let the code/data be the source of truth rather than
   carrying a copy here. If a model has no rule, stop and report — do not
   invent one.

5. **Preview** the affected COUNT and a small sample, then write one UPDATE
   per slice. The `WHERE` filter encodes the write mode (add `cost_json IS
   NULL` for fill-only; omit it to overwrite). After each write, re-count
   the slice to prove it landed.

6. **Report** per slice: upstream, model_key, JSON written, rows updated.

## Cautions

- Production D1. Treat every UPDATE as a deploy-grade action.
- `cost_json` shape must match `ModelPricing`: numeric `input`/`output`,
  optional `cache_read`/`cache_write`. Validate before writing — bad JSON
  silently misreports cost in aggregation.
- Writing today's price into old rows is the intended behavior. If the human
  wants price-at-the-time, they must supply the JSON.

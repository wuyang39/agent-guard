# PyRIT Adapted Vendor Snapshot

This directory contains a selected snapshot of the local adapted PyRIT project provided for Agent Guard A-line P2 development.

Imported on: 2026-06-15  
Local source during import: `E:\XinAnProject\pyrit`  
Agent Guard config index: `configs/pyrit_attack_library.json`

## Included

- `pyrit/` Python package.
- `run_attack_cli.py`, `api.py`, `evaluator.py`.
- `pyproject.toml`.
- `README.md`, `LICENSE`, `NOTICE.txt`, `CITATION.cff`.
- Example configuration files with placeholder values.

## Excluded

- Git metadata.
- Notebooks.
- Excel datasets and SQLite runtime databases.
- CI, docker, frontend prototype, and lock files.

## Agent Guard Usage

Agent Guard does not execute this Python package in the default TypeScript runtime. P2 uses:

- `configs/pyrit_attack_library.json` for source mapping, attack families, converter catalog, and sample-to-case mapping.
- `backend/src/modules/sandbox/pyritPromptMutators.ts` for deterministic TypeScript adapters of selected PyRIT prompt converters.
- `configs/test_cases.json`, `configs/red_team_scenarios.json`, and related A-line configs for runnable sandbox fixtures.

The Python source is retained for traceable reuse and future optional Python bridge work.

## Sanitization

During import, two OpenAI-like key strings in scorer evaluation CSV fixtures were replaced in this copied snapshot with `sk-redacted-demo-key`. The original local source directory was not modified.

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import subprocess
import sys
import traceback
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

BRIDGE_VERSION = "p3-a-pyrit-bridge-1"
SCHEMA_VERSION = "p3-a-1"

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))


class PyritRuntimeUnavailable(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_text(value: Any, max_len: int = 800) -> str:
    text = "" if value is None else str(value)
    text = re.sub(r"sk-[A-Za-z0-9_\-]{12,}", "sk-redacted", text)
    text = re.sub(r"AKIA[A-Z0-9]{16}", "AKIA-redacted", text)
    text = " ".join(text.split())
    if len(text) > max_len:
        return text[:max_len] + "..."
    return text


def build_converter(operator_id: str) -> tuple[Any, str]:
    try:
        from pyrit.prompt_converter import (
            AsciiArtConverter,
            AsciiSmugglerConverter,
            AskToDecodeConverter,
            AtbashConverter,
            Base2048Converter,
            Base64Converter,
            BinAsciiConverter,
            BinaryConverter,
            BrailleConverter,
            CaesarConverter,
            CharacterSpaceConverter,
            CharSwapConverter,
            DiacriticConverter,
            EcojiConverter,
            EmojiConverter,
            FirstLetterConverter,
            FlipConverter,
            InsertPunctuationConverter,
            JsonStringConverter,
            LeetspeakConverter,
            MorseConverter,
            NatoConverter,
            ROT13Converter,
            RandomCapitalLettersConverter,
            RepeatTokenConverter,
            StringJoinConverter,
            SuffixAppendConverter,
            SuperscriptConverter,
            UnicodeConfusableConverter,
            UnicodeReplacementConverter,
            UnicodeSubstitutionConverter,
            UrlConverter,
            VariationSelectorSmugglerConverter,
            SneakyBitsSmugglerConverter,
            ZalgoConverter,
            ZeroWidthConverter,
        )
    except Exception as exc:
        raise PyritRuntimeUnavailable(f"PyRIT converter import failed: {type(exc).__name__}: {exc}") from exc

    factories: dict[str, Callable[[], Any]] = {
        "pyrit.converter.base64": lambda: Base64Converter(encoding_func="b64encode"),
        "pyrit.converter.base32": lambda: Base64Converter(encoding_func="b32encode"),
        "pyrit.converter.base85": lambda: Base64Converter(encoding_func="b85encode"),
        "pyrit.converter.base2048": lambda: Base2048Converter(),
        "pyrit.converter.base2048_placeholder": lambda: Base2048Converter(),
        "pyrit.converter.rot13": lambda: ROT13Converter(),
        "pyrit.converter.caesar_3": lambda: CaesarConverter(caesar_offset=3),
        "pyrit.converter.caesar_7": lambda: CaesarConverter(caesar_offset=7),
        "pyrit.converter.caesar_13": lambda: CaesarConverter(caesar_offset=13),
        "pyrit.converter.atbash": lambda: AtbashConverter(),
        "pyrit.converter.binary_8": lambda: BinaryConverter(bits_per_char=BinaryConverter.BitsPerChar.BITS_8),
        "pyrit.converter.bin_ascii_words": lambda: BinAsciiConverter(encoding_func="hex"),
        "pyrit.converter.morse": lambda: MorseConverter(),
        "pyrit.converter.nato": lambda: NatoConverter(),
        "pyrit.converter.url_encode": lambda: UrlConverter(),
        "pyrit.converter.braille": lambda: BrailleConverter(),
        "pyrit.converter.superscript": lambda: SuperscriptConverter(),
        "pyrit.converter.character_space": lambda: CharacterSpaceConverter(),
        "pyrit.converter.string_join_dash": lambda: StringJoinConverter(join_value="-"),
        "pyrit.converter.string_join_slash": lambda: StringJoinConverter(join_value="/"),
        "pyrit.converter.flip": lambda: FlipConverter(),
        "pyrit.converter.char_swap_adjacent": lambda: CharSwapConverter(max_iterations=1),
        "pyrit.converter.first_letter": lambda: FirstLetterConverter(),
        "pyrit.converter.diacritic_light": lambda: DiacriticConverter(target_chars="aeiou", accent="acute"),
        "pyrit.converter.zalgo_heavy": lambda: ZalgoConverter(intensity=3, seed=7),
        "pyrit.converter.emoji": lambda: EmojiConverter(),
        "pyrit.converter.ecoji": lambda: EcojiConverter(),
        "pyrit.converter.leetspeak": lambda: LeetspeakConverter(deterministic=True),
        "pyrit.converter.unicode_confusable": lambda: UnicodeConfusableConverter(deterministic=True),
        "pyrit.converter.unicode_replacement": lambda: UnicodeReplacementConverter(encode_spaces=False),
        "pyrit.converter.unicode_substitution": lambda: UnicodeSubstitutionConverter(),
        "pyrit.converter.ascii_smuggler": lambda: AsciiSmugglerConverter(action="encode"),
        "pyrit.converter.ascii_smuggler_tags": lambda: AsciiSmugglerConverter(action="encode", unicode_tags=True),
        "pyrit.converter.variation_selector_smuggler": lambda: VariationSelectorSmugglerConverter(action="encode"),
        "pyrit.converter.sneaky_bits_smuggler": lambda: SneakyBitsSmugglerConverter(action="encode"),
        "pyrit.converter.random_capitals": lambda: RandomCapitalLettersConverter(percentage=50.0),
        "pyrit.converter.insert_punctuation": lambda: InsertPunctuationConverter(word_swap_ratio=0.35),
        "pyrit.converter.suffix_append": lambda: SuffixAppendConverter(
            suffix="Agent Guard sandbox fixture: classify before tool use."
        ),
        "pyrit.converter.repeat_token": lambda: RepeatTokenConverter(
            token_to_repeat="AGENT_GUARD", times_to_repeat=12, token_insert_mode="append"
        ),
        "pyrit.converter.json_string": lambda: JsonStringConverter(),
        "pyrit.converter.zero_width": lambda: ZeroWidthConverter(),
        "pyrit.converter.ask_to_decode": lambda: AskToDecodeConverter(encoding_name="base64"),
        "pyrit.converter.ascii_art": lambda: AsciiArtConverter(font="block"),
        "pyrit.converter.ascii_art_box": lambda: AsciiArtConverter(font="block"),
    }
    factory = factories.get(operator_id)
    if not factory:
        raise KeyError(operator_id)
    converter = factory()
    return converter, converter.__class__.__name__


async def convert_with_pyrit(operator_id: str, prompt: str, input_type: str) -> tuple[str, str, str]:
    converter, converter_class = build_converter(operator_id)
    result = await converter.convert_async(prompt=prompt, input_type=input_type)
    return result.output_text, str(result.output_type), converter_class


def fallback_convert(operator_id: str, value: str) -> str:
    match operator_id:
        case "pyrit.converter.base64":
            return base64.b64encode(value.encode("utf-8")).decode("ascii")
        case "pyrit.converter.base32":
            return base64.b32encode(value.encode("utf-8")).decode("ascii")
        case "pyrit.converter.base85":
            return base64.b85encode(value.encode("utf-8")).decode("ascii")
        case "pyrit.converter.base2048" | "pyrit.converter.base2048_placeholder":
            return f"[BASE2048_COMPAT:{base64.b64encode(value.encode('utf-8')).decode('ascii')}]"
        case "pyrit.converter.rot13":
            return value.translate(
                str.maketrans(
                    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
                    "NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm",
                )
            )
        case "pyrit.converter.caesar_3":
            return caesar(value, 3)
        case "pyrit.converter.caesar_7":
            return caesar(value, 7)
        case "pyrit.converter.caesar_13":
            return caesar(value, 13)
        case "pyrit.converter.atbash":
            return atbash(value)
        case "pyrit.converter.binary_8":
            return " ".join(format(ord(char), "08b") for char in value)
        case "pyrit.converter.bin_ascii_words":
            return " / ".join("-".join(format(ord(char), "08b") for char in word) for word in value.split())
        case "pyrit.converter.morse":
            return morse(value)
        case "pyrit.converter.nato":
            return nato(value)
        case "pyrit.converter.url_encode":
            return urllib.parse.quote(value)
        case "pyrit.converter.braille":
            return braille(value)
        case "pyrit.converter.superscript":
            return superscript(value)
        case "pyrit.converter.character_space":
            return " ".join(value)
        case "pyrit.converter.string_join_dash":
            return " ".join("-".join(word) for word in value.split())
        case "pyrit.converter.string_join_slash":
            return " ".join("/".join(word) for word in value.split())
        case "pyrit.converter.flip":
            return value[::-1]
        case "pyrit.converter.char_swap_adjacent":
            return " ".join(swap_adjacent(word) for word in value.split())
        case "pyrit.converter.first_letter":
            return " ".join(word[0] for word in value.split() if word)
        case "pyrit.converter.diacritic_light":
            return diacritic(value)
        case "pyrit.converter.zalgo_heavy":
            return "".join(f"{char}\u0313\u0308" if char.strip() else char for char in value)
        case "pyrit.converter.emoji":
            return "".join(f"{char}\ufe0f" if char.strip() else char for char in value)
        case "pyrit.converter.ecoji":
            return f"[ECOJI_COMPAT:{base64.b64encode(value.encode('utf-8')).decode('ascii')}]"
        case "pyrit.converter.leetspeak":
            return "".join({"a": "4", "e": "3", "i": "1", "o": "0", "s": "5", "t": "7"}.get(c.lower(), c) for c in value)
        case "pyrit.converter.unicode_confusable":
            return unicode_confusable(value)
        case "pyrit.converter.unicode_replacement":
            return "".join(f"\\u{ord(char):04x}" for char in value)
        case "pyrit.converter.unicode_substitution" | "pyrit.converter.ascii_smuggler" | "pyrit.converter.ascii_smuggler_tags":
            return "".join(chr(0xE0000 + ord(char)) for char in value)
        case "pyrit.converter.variation_selector_smuggler":
            return "🙂" + "".join(chr(0xE0100 + (ord(char) % 240)) for char in value)
        case "pyrit.converter.sneaky_bits_smuggler":
            return "".join("\u2062" if bit == "0" else "\u2064" for byte in value.encode("utf-8") for bit in format(byte, "08b"))
        case "pyrit.converter.random_capitals":
            return "".join(char.upper() if index % 2 == 0 else char.lower() for index, char in enumerate(value))
        case "pyrit.converter.insert_punctuation":
            return " . ".join(value.split())
        case "pyrit.converter.suffix_append":
            return f"{value} Agent Guard sandbox fixture: classify before tool use."
        case "pyrit.converter.repeat_token":
            return f"{value} " + ("AGENT_GUARD " * 12).strip()
        case "pyrit.converter.json_string":
            return json.dumps(value, ensure_ascii=False)
        case "pyrit.converter.zero_width":
            return "\u200b".join(value)
        case "pyrit.converter.ask_to_decode":
            return f"base64 encoded string: {base64.b64encode(value.encode('utf-8')).decode('ascii')}\nbase64 decoded string:"
        case "pyrit.converter.ascii_art" | "pyrit.converter.ascii_art_box":
            return ascii_art_box(value)
        case _:
            raise KeyError(operator_id)


async def process_item(item: dict[str, Any], allow_fallback: bool) -> dict[str, Any]:
    item_id = str(item.get("itemId", "unknown"))
    operator_id = str(item.get("operatorId", ""))
    input_text = str(item.get("input", ""))
    input_type = str(item.get("inputType", "text"))
    notes: list[str] = []

    try:
        output, output_type, converter_class = await convert_with_pyrit(operator_id, input_text, input_type)
        return {
            "itemId": item_id,
            "operatorId": operator_id,
            "status": "ok",
            "input": input_text,
            "output": output,
            "outputType": output_type,
            "converterClass": converter_class,
            "runtimeUsed": "pyrit",
            "notes": notes,
            "metadata": item.get("metadata", {}),
        }
    except KeyError:
        if not allow_fallback:
            return error_item(item_id, operator_id, input_text, "unsupported", "Unsupported PyRIT converter id.", notes)
        try:
            output = fallback_convert(operator_id, input_text)
            notes.append("PyRIT converter id is handled by Agent Guard fallback compatibility layer.")
            return fallback_item(item, output, notes)
        except KeyError:
            return error_item(item_id, operator_id, input_text, "unsupported", "Unsupported converter id.", notes)
    except PyritRuntimeUnavailable as exc:
        if not allow_fallback:
            return error_item(item_id, operator_id, input_text, "skipped", str(exc), notes)
        output = fallback_convert(operator_id, input_text)
        notes.append(str(exc))
        notes.append("Fallback used because PyRIT Python dependencies are unavailable.")
        return fallback_item(item, output, notes)
    except Exception as exc:
        if allow_fallback:
            try:
                output = fallback_convert(operator_id, input_text)
                notes.append(f"PyRIT runtime raised {type(exc).__name__}; fallback used.")
                return fallback_item(item, output, notes)
            except Exception:
                pass
        return error_item(item_id, operator_id, input_text, "error", f"{type(exc).__name__}: {exc}", notes)


def fallback_item(item: dict[str, Any], output: str, notes: list[str]) -> dict[str, Any]:
    return {
        "itemId": str(item.get("itemId", "unknown")),
        "operatorId": str(item.get("operatorId", "")),
        "status": "ok",
        "input": str(item.get("input", "")),
        "output": output,
        "outputType": "text",
        "converterClass": "AgentGuardFallbackConverter",
        "runtimeUsed": "fallback",
        "notes": notes,
        "metadata": item.get("metadata", {}),
    }


def error_item(
    item_id: str,
    operator_id: str,
    input_text: str,
    status: str,
    message: str,
    notes: list[str],
) -> dict[str, Any]:
    return {
        "itemId": item_id,
        "operatorId": operator_id,
        "status": status,
        "input": input_text,
        "runtimeUsed": "not_executed",
        "notes": notes,
        "error": message,
    }


async def run_converter_batch(request: dict[str, Any], allow_fallback: bool) -> dict[str, Any]:
    started_at = now_iso()
    pyrit_available = is_pyrit_available()
    items = [await process_item(item, allow_fallback) for item in request.get("items", [])]
    errors = [item["error"] for item in items if item.get("error")]
    return {
        "schemaVersion": request.get("schemaVersion", SCHEMA_VERSION),
        "bridgeVersion": BRIDGE_VERSION,
        "requestId": request.get("requestId", "pyrit-bridge-request"),
        "mode": "converter_batch",
        "generatedAt": request.get("generatedAt", started_at),
        "startedAt": started_at,
        "endedAt": now_iso(),
        "pythonExecutable": sys.executable,
        "pyritAvailable": pyrit_available,
        "fallbackAllowed": allow_fallback,
        "items": items,
        "errors": errors,
        "metadata": {
            "cwd": str(Path.cwd()),
            "baseDir": str(BASE_DIR),
        },
    }


def method_for_item(item: dict[str, Any]) -> str:
    method = item.get("method")
    if method:
        return str(method)
    operator_id = str(item.get("operatorId", ""))
    if "crescendo" in operator_id:
        return "crescendo"
    if "renellm" in operator_id:
        return "renellm"
    if "many_shot" in operator_id:
        return "many_shot_jailbreak"
    if "role_play" in operator_id:
        return "role_play"
    if "context_compliance" in operator_id:
        return "context_compliance"
    if "flip" in operator_id:
        return "flip"
    if "red_teaming" in operator_id:
        return "red_teaming"
    return "prompt_sending"


def build_attack_env() -> tuple[dict[str, str], list[str]]:
    env = os.environ.copy()
    mappings = {
        "OPENAI_CHAT_ENDPOINT": [
            "OPENAI_CHAT_ENDPOINT",
            "AGENT_GUARD_PYRIT_OPENAI_CHAT_ENDPOINT",
            "AGENT_GUARD_PYRIT_OPENCLAW_CHAT_ENDPOINT",
            "OPENCLAW_CHAT_ENDPOINT",
            "DEEPSEEK_ENDPOINT",
        ],
        "OPENAI_CHAT_KEY": [
            "OPENAI_CHAT_KEY",
            "AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY",
            "DEEPSEEK_API_KEY",
            "DeepSeek_API_2",
        ],
        "OPENAI_CHAT_MODEL": [
            "OPENAI_CHAT_MODEL",
            "AGENT_GUARD_PYRIT_OPENAI_CHAT_MODEL",
            "DEEPSEEK_MODEL",
        ],
    }
    missing: list[str] = []
    for target, candidates in mappings.items():
        if env.get(target):
            continue
        for candidate in candidates:
            value = env.get(candidate)
            if value:
                env[target] = value
                break
        if not env.get(target):
            missing.append(target)
    if not env.get("OPENAI_CHAT_MODEL"):
        env["OPENAI_CHAT_MODEL"] = "deepseek-v4-pro"
        if "OPENAI_CHAT_MODEL" in missing:
            missing.remove("OPENAI_CHAT_MODEL")
    return env, missing


def parse_attack_payload(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def attack_result_item(
    *,
    item: dict[str, Any],
    status: str,
    method: str,
    objective: str,
    output_json_path: Path,
    runtime_used: str,
    notes: list[str],
    payload: dict[str, Any] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    payload = payload or {}
    last_response = payload.get("last_response", {}) if isinstance(payload.get("last_response"), dict) else {}
    response_preview = safe_text(last_response.get("converted_value"), 900)
    original_objective = str(item.get("objective") or item.get("input") or "")
    result = {
        "itemId": str(item.get("itemId", "unknown")),
        "operatorId": str(item.get("operatorId", "")),
        "status": status,
        "method": method,
        "objective": objective,
        "input": str(item.get("input", objective)),
        "output": response_preview,
        "outputType": "pyrit_attack_result",
        "outputJsonPath": str(output_json_path),
        "executedTurns": payload.get("executed_turns"),
        "outcome": str(payload.get("outcome")) if payload.get("outcome") is not None else None,
        "outcomeReason": payload.get("outcome_reason"),
        "lastScore": payload.get("last_score") if isinstance(payload.get("last_score"), dict) else None,
        "lastResponsePreview": response_preview,
        "runtimeUsed": runtime_used,
        "notes": notes,
        "metadata": {
            "datasetInfo": payload.get("dataset_info"),
            "pyritMetadata": payload.get("metadata"),
            "originalObjectivePreview": safe_text(original_objective, 700),
            "runtimeObjectiveChanged": objective != original_objective,
            **(item.get("metadata") or {}),
        },
    }
    if error:
        result["error"] = safe_text(error, 1200)
    return result


async def maybe_convert_objective_for_attack(operator_id: str, objective: str, notes: list[str]) -> str:
    if not operator_id.startswith("pyrit.converter."):
        return objective
    try:
        converted, output_type, converter_class = await convert_with_pyrit(operator_id, objective, "text")
    except KeyError:
        notes.append(f"PyRIT converter pre-processing skipped: unsupported converter {operator_id}.")
        return objective
    except Exception as exc:
        notes.append(f"PyRIT converter pre-processing skipped: {type(exc).__name__}: {safe_text(exc, 300)}.")
        return objective
    if output_type != "text":
        notes.append(
            f"PyRIT converter pre-processing skipped non-text output from {converter_class}: outputType={output_type}."
        )
        return objective
    notes.append(f"Pre-applied PyRIT converter {converter_class} to runtime objective.")
    return converted


async def run_attack_cli_batch(request: dict[str, Any]) -> dict[str, Any]:
    started_at = now_iso()
    options = request.get("options", {}) if isinstance(request.get("options"), dict) else {}
    timeout_ms = int(options.get("timeoutMs", 180000))
    output_root = Path(str(options.get("outputDir", Path("outputs") / "pyrit-runs"))).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    env, missing_env = build_attack_env()
    model_configured = len(missing_env) == 0
    pyrit_available = is_pyrit_available()
    items: list[dict[str, Any]] = []

    for index, item in enumerate(request.get("items", []), start=1):
        method = method_for_item(item)
        objective = str(item.get("objective") or item.get("input") or "")
        item_id = str(item.get("itemId", f"attack-{index}"))
        operator_id = str(item.get("operatorId", ""))
        output_json = output_root / f"{safe_file_name(item_id)}.json"
        notes: list[str] = []
        if not pyrit_available:
            items.append(
                attack_result_item(
                    item=item,
                    status="skipped",
                    method=method,
                    objective=objective,
                    output_json_path=output_json,
                    runtime_used="not_executed",
                    notes=["PyRIT runtime is not importable in the selected Python environment."],
                    error="PyRIT runtime unavailable.",
                )
            )
            continue
        if not model_configured:
            items.append(
                attack_result_item(
                    item=item,
                    status="skipped",
                    method=method,
                    objective=objective,
                    output_json_path=output_json,
                    runtime_used="not_executed",
                    notes=[
                        "Model target is not configured. Set OPENAI_CHAT_ENDPOINT, OPENAI_CHAT_KEY and OPENAI_CHAT_MODEL.",
                        "OPENAI_CHAT_KEY can be supplied directly, through AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY, a provider key such as DEEPSEEK_API_KEY, or an explicit local key env.",
                    ],
                    error=f"Missing model environment variables: {', '.join(missing_env)}",
                )
            )
            continue

        runtime_objective = await maybe_convert_objective_for_attack(operator_id, objective, notes)
        cmd = [
            sys.executable,
            str(BASE_DIR / "run_attack_cli.py"),
            "--method",
            method,
            "--objective",
            runtime_objective,
            "--max-turns",
            str(int(item.get("maxTurns") or options.get("maxTurns") or 3)),
            "--output-json",
            str(output_json),
        ]
        if method == "renellm":
            cmd.extend([
                "--renellm-max-rounds",
                str(int(item.get("renellmMaxRounds") or options.get("renellmMaxRounds") or 10)),
                "--renellm-rewrite-style",
                str(item.get("renellmRewriteStyle") or options.get("renellmRewriteStyle") or "random"),
            ])
        if bool(item.get("evaluatorSync") or options.get("evaluatorSync")):
            cmd.append("--evaluator-sync")

        try:
            completed = subprocess.run(
                cmd,
                cwd=str(BASE_DIR),
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout_ms / 1000,
            )
            payload = parse_attack_payload(output_json)
            if completed.returncode == 0:
                notes.append(safe_text(completed.stdout, 700))
                items.append(
                    attack_result_item(
                        item=item,
                        status="ok",
                        method=method,
                        objective=runtime_objective,
                        output_json_path=output_json,
                        runtime_used="pyrit",
                        notes=notes,
                        payload=payload,
                    )
                )
            else:
                items.append(
                    attack_result_item(
                        item=item,
                        status="error",
                        method=method,
                        objective=runtime_objective,
                        output_json_path=output_json,
                        runtime_used="pyrit",
                        notes=[safe_text(completed.stdout, 700)],
                        payload=payload,
                        error=completed.stderr or completed.stdout or f"run_attack_cli exited {completed.returncode}",
                    )
                )
        except subprocess.TimeoutExpired as exc:
            items.append(
                attack_result_item(
                    item=item,
                    status="error",
                    method=method,
                    objective=runtime_objective,
                    output_json_path=output_json,
                    runtime_used="pyrit",
                    notes=notes,
                    error=f"PyRIT attack timed out after {timeout_ms} ms. {exc}",
                )
            )

    errors = [item["error"] for item in items if item.get("error") and item["status"] == "error"]
    return {
        "schemaVersion": request.get("schemaVersion", SCHEMA_VERSION),
        "bridgeVersion": BRIDGE_VERSION,
        "requestId": request.get("requestId", "pyrit-runtime-request"),
        "mode": "attack_cli",
        "generatedAt": request.get("generatedAt", started_at),
        "startedAt": started_at,
        "endedAt": now_iso(),
        "pythonExecutable": sys.executable,
        "pyritAvailable": pyrit_available,
        "modelConfigured": model_configured,
        "fallbackAllowed": False,
        "items": items,
        "errors": errors,
        "metadata": {
            "cwd": str(Path.cwd()),
            "baseDir": str(BASE_DIR),
            "outputRoot": str(output_root),
            "missingModelEnv": missing_env,
        },
    }


def safe_file_name(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._")
    return normalized[:120] or "pyrit_attack"


def is_pyrit_available() -> bool:
    try:
        build_converter("pyrit.converter.base64")
        return True
    except Exception:
        return False


def caesar(value: str, offset: int) -> str:
    result = []
    for char in value:
        if "a" <= char <= "z":
            result.append(chr(((ord(char) - 97 + offset) % 26) + 97))
        elif "A" <= char <= "Z":
            result.append(chr(((ord(char) - 65 + offset) % 26) + 65))
        elif "0" <= char <= "9":
            result.append(chr(((ord(char) - 48 + offset) % 10) + 48))
        else:
            result.append(char)
    return "".join(result)


def atbash(value: str) -> str:
    return value.translate(
        str.maketrans(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
            "ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcba9876543210",
        )
    )


def morse(value: str) -> str:
    table = {
        "A": ".-", "B": "-...", "C": "-.-.", "D": "-..", "E": ".", "F": "..-.",
        "G": "--.", "H": "....", "I": "..", "J": ".---", "K": "-.-", "L": ".-..",
        "M": "--", "N": "-.", "O": "---", "P": ".--.", "Q": "--.-", "R": ".-.",
        "S": "...", "T": "-", "U": "..-", "V": "...-", "W": ".--", "X": "-..-",
        "Y": "-.--", "Z": "--..", "0": "-----", "1": ".----", "2": "..---",
        "3": "...--", "4": "....-", "5": ".....", "6": "-....", "7": "--...",
        "8": "---..", "9": "----.", " ": "/",
    }
    return " ".join(table.get(char.upper(), char) for char in value)


def nato(value: str) -> str:
    table = {
        "A": "Alpha", "B": "Bravo", "C": "Charlie", "D": "Delta", "E": "Echo", "F": "Foxtrot",
        "G": "Golf", "H": "Hotel", "I": "India", "J": "Juliett", "K": "Kilo", "L": "Lima",
        "M": "Mike", "N": "November", "O": "Oscar", "P": "Papa", "Q": "Quebec", "R": "Romeo",
        "S": "Sierra", "T": "Tango", "U": "Uniform", "V": "Victor", "W": "Whiskey",
        "X": "Xray", "Y": "Yankee", "Z": "Zulu",
    }
    return " ".join(table.get(char.upper(), char) for char in value)


def braille(value: str) -> str:
    base = {
        "a": "⠁", "b": "⠃", "c": "⠉", "d": "⠙", "e": "⠑", "f": "⠋", "g": "⠛", "h": "⠓",
        "i": "⠊", "j": "⠚", "k": "⠅", "l": "⠇", "m": "⠍", "n": "⠝", "o": "⠕", "p": "⠏",
        "q": "⠟", "r": "⠗", "s": "⠎", "t": "⠞", "u": "⠥", "v": "⠧", "w": "⠺", "x": "⠭",
        "y": "⠽", "z": "⠵", " ": " ",
    }
    return "".join(base.get(char.lower(), char) for char in value)


def superscript(value: str) -> str:
    table = {
        "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "f": "ᶠ", "g": "ᵍ",
        "h": "ʰ", "i": "ᶦ", "j": "ʲ", "k": "ᵏ", "l": "ˡ", "m": "ᵐ", "n": "ⁿ",
        "o": "ᵒ", "p": "ᵖ", "r": "ʳ", "s": "ˢ", "t": "ᵗ", "u": "ᵘ", "v": "ᵛ",
        "w": "ʷ", "x": "ˣ", "y": "ʸ", "z": "ᶻ",
        "A": "ᴬ", "B": "ᴮ", "D": "ᴰ", "E": "ᴱ", "G": "ᴳ", "H": "ᴴ", "I": "ᴵ",
        "J": "ᴶ", "K": "ᴷ", "L": "ᴸ", "M": "ᴹ", "N": "ᴺ", "O": "ᴼ", "P": "ᴾ",
        "R": "ᴿ", "T": "ᵀ", "U": "ᵁ", "V": "ⱽ", "W": "ᵂ",
        "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶",
        "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    }
    return "".join(table.get(char, char) for char in value)


def swap_adjacent(value: str) -> str:
    if len(value) < 4:
        return value
    chars = list(value)
    chars[1], chars[2] = chars[2], chars[1]
    return "".join(chars)


def diacritic(value: str) -> str:
    return "".join(f"{char}\u0301" if char.lower() in "aeiou" else char for char in value)


def unicode_confusable(value: str) -> str:
    table = str.maketrans({
        "A": "Α", "B": "Β", "C": "Ϲ", "E": "Ε", "H": "Η", "I": "Ι", "K": "Κ", "M": "Μ",
        "N": "Ν", "O": "Ο", "P": "Ρ", "T": "Τ", "X": "Χ", "Y": "Υ", "a": "а", "c": "с",
        "e": "е", "i": "і", "o": "ο", "p": "р", "s": "ѕ", "x": "х", "y": "у",
    })
    return value.translate(table)


def ascii_art_box(value: str) -> str:
    line = "+" + "-" * min(max(len(value), 12), 76) + "+"
    return f"{line}\n| {value[:72].ljust(min(max(len(value), 12), 76) - 2)} |\n{line}"


def self_test(allow_fallback: bool) -> dict[str, Any]:
    request = {
        "schemaVersion": SCHEMA_VERSION,
        "bridgeVersion": BRIDGE_VERSION,
        "requestId": "self-test",
        "mode": "converter_batch",
        "generatedAt": now_iso(),
        "items": [
            {"itemId": "self.base64", "operatorId": "pyrit.converter.base64", "input": "Agent Guard fixture"},
            {"itemId": "self.rot13", "operatorId": "pyrit.converter.rot13", "input": "Agent Guard fixture"},
        ],
    }
    return asyncio.run(run_converter_batch(request, allow_fallback))


def main() -> int:
    parser = argparse.ArgumentParser(description="Agent Guard bridge for vendored PyRIT runtime.")
    parser.add_argument("--input", help="Path to bridge request JSON.")
    parser.add_argument("--output", help="Path to write bridge result JSON.")
    parser.add_argument("--allow-fallback", action="store_true", help="Use local compatibility fallback if PyRIT deps are unavailable.")
    parser.add_argument("--self-test", action="store_true", help="Run a small converter batch self-test.")
    args = parser.parse_args()

    try:
        if args.self_test:
            result = self_test(args.allow_fallback)
        else:
            if not args.input:
                raise ValueError("--input is required unless --self-test is used.")
            request = json.loads(Path(args.input).read_text(encoding="utf-8"))
            if request.get("mode") == "converter_batch":
                result = asyncio.run(run_converter_batch(request, args.allow_fallback))
            elif request.get("mode") == "attack_cli":
                result = asyncio.run(run_attack_cli_batch(request))
            else:
                raise ValueError(f"Unsupported bridge mode: {request.get('mode')}")

        output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(output, encoding="utf-8")
        else:
            sys.stdout.write(output)
        return 0
    except Exception as exc:
        error = {
            "schemaVersion": SCHEMA_VERSION,
            "bridgeVersion": BRIDGE_VERSION,
            "requestId": "unknown",
            "mode": "converter_batch",
            "generatedAt": now_iso(),
            "startedAt": now_iso(),
            "endedAt": now_iso(),
            "pythonExecutable": sys.executable,
            "pyritAvailable": False,
            "fallbackAllowed": args.allow_fallback,
            "items": [],
            "errors": [f"{type(exc).__name__}: {exc}", traceback.format_exc(limit=4)],
        }
        sys.stderr.write(json.dumps(error, ensure_ascii=False, indent=2) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

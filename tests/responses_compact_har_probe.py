#!/usr/bin/env python3
"""
基于 HAR 中真实 `/responses/compact` 请求体做稳定性探针。

目标：
- 不再使用手工编造的 payload，而是直接复用用户实际失败时抓到的 compact body；
- 按不同的“目标请求大小”把 HAR 里的 `input` 裁成最新 turn 后缀，验证当前 endpoint
  在多大 bytes / 多大近似 token 下开始稳定返回合法 JSON；
- 同时对比 `instructions` 原样保留与直接移除两种模式，帮助判断当前失败更偏向
  载荷体积问题还是 `instructions` 语义问题。

运行示例：
- `uv run --with tiktoken python tests/responses_compact_har_probe.py --repo-root . --har-path C:\\Users\\wintermute\\Downloads\\responsecompress.har --output-dir output/playwright/compact-har-probe`
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

try:
    import tiktoken  # type: ignore
except Exception:  # pragma: no cover
    tiktoken = None


TARGET_REQUEST_BYTES = [
    868_113,
    800_000,
    700_000,
    600_000,
    500_000,
    400_000,
    320_000,
    280_000,
    250_000,
    220_000,
    200_000,
    180_000,
    160_000,
    140_000,
    120_000,
    100_000,
    80_000,
    60_000,
    40_000,
]


def parse_dotenv(content: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw_line in str(content or "").splitlines():
      line = raw_line.strip()
      if not line or line.startswith("#"):
          continue
      if "=" not in line:
          continue
      key, raw_value = line.split("=", 1)
      key = key.strip()
      value = raw_value.strip()
      if (
          len(value) >= 2
          and ((value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")))
      ):
          value = value[1:-1]
      env[key] = value
    return env


def load_fixed_api_env(repo_root: Path) -> dict[str, str]:
    env_path = repo_root / ".env"
    env = parse_dotenv(env_path.read_text(encoding="utf-8"))
    base_url = env.get("CEREBR_FIXED_RESPONSES_BASE_URL", "").strip()
    api_key = env.get("CEREBR_FIXED_RESPONSES_API_KEY", "").strip()
    if not base_url:
        raise RuntimeError(".env 缺少 CEREBR_FIXED_RESPONSES_BASE_URL")
    if not api_key:
        raise RuntimeError(".env 缺少 CEREBR_FIXED_RESPONSES_API_KEY")
    return {
        "responses_base_url": base_url,
        "responses_api_key": api_key,
    }


def read_har_compact_request(har_path: Path) -> tuple[str, dict[str, Any]]:
    har = json.loads(har_path.read_text(encoding="utf-8"))
    for entry in har.get("log", {}).get("entries", []):
        request = entry.get("request") or {}
        url = str(request.get("url") or "")
        if "/responses/compact" not in url:
            continue
        post_data = request.get("postData") or {}
        text = post_data.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        return url, json.loads(text)
    raise RuntimeError("HAR 中未找到有效的 /responses/compact 请求")


def json_clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def estimate_bytes(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def extract_visible_text_segments(value: Any) -> list[str]:
    segments: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, str):
            segments.append(node)
            return
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return

        node_type = str(node.get("type") or "").strip().lower()
        if node_type in {"input_text", "output_text", "text"} and isinstance(node.get("text"), str):
            segments.append(node["text"])
        if isinstance(node.get("arguments"), str):
            segments.append(node["arguments"])
        if isinstance(node.get("name"), str):
            segments.append(node["name"])
        if isinstance(node.get("instructions"), str):
            segments.append(node["instructions"])
        if isinstance(node.get("role"), str):
            pass

        for key in ("input", "content", "output", "summary", "body", "items"):
            if key in node:
                walk(node[key])

    walk(value)
    return [text for text in segments if text]


def build_token_counter():
    if tiktoken is None:
        return None
    try:
        return tiktoken.get_encoding("o200k_base")
    except Exception:
        return None


ENCODER = build_token_counter()


def count_tokens(text: str) -> int | None:
    if ENCODER is None:
        return None
    try:
        return len(ENCODER.encode(text, disallowed_special=()))
    except Exception:
        return None


def load_codex_base_instructions(repo_root: Path, model_slug: str = "gpt-5.4") -> str:
    models_path = repo_root / ".." / "codex-remote" / "reference" / "openai-codex" / "codex-rs" / "core" / "models.json"
    raw_models = json.loads(models_path.read_text(encoding="utf-8"))
    models = raw_models.get("models") if isinstance(raw_models, dict) else raw_models
    if not isinstance(models, list):
        raise RuntimeError(f"{models_path} 不是预期的 models 列表结构")
    for model in models:
        if str(model.get("slug") or "").strip() != model_slug:
            continue
        instructions = model.get("base_instructions")
        if isinstance(instructions, str) and instructions.strip():
            return instructions
    raise RuntimeError(f"未在 {models_path} 找到 {model_slug} 的 Codex base_instructions")


def truncate_text_middle(text: str, max_chars: int) -> str:
    chars = list(text)
    if len(chars) <= max_chars:
        return text
    notice = "[... compact truncated ...]"
    if max_chars <= len(notice) + 2:
        return "".join(chars[:max_chars])
    remaining = max_chars - len(notice)
    prefix = (remaining + 1) // 2
    suffix = remaining - prefix
    return "".join(chars[:prefix]) + notice + "".join(chars[-suffix:])


def sanitize_function_output_payload(output: Any, max_text_chars: int) -> Any:
    if isinstance(output, str):
        return truncate_text_middle(output, max_text_chars)
    if isinstance(output, list):
        items = []
        for item in output:
            if not isinstance(item, dict):
                items.append(item)
                continue
            cloned = json_clone(item)
            item_type = str(cloned.get("type") or "").strip().lower()
            if item_type in {"input_text", "output_text"} and isinstance(cloned.get("text"), str):
                cloned["text"] = truncate_text_middle(cloned["text"], max_text_chars)
            elif item_type == "input_image" and isinstance(cloned.get("image_url"), str):
                image_url = cloned["image_url"]
                if image_url.startswith("data:"):
                    detail = str(cloned.get("detail") or "").strip()
                    detail_suffix = f" detail={detail}" if detail else ""
                    cloned = {
                        "type": "input_text",
                        "text": f"[inline image omitted from compact request; source=data-url{detail_suffix}]",
                    }
            items.append(cloned)
        return items
    if isinstance(output, dict):
        cloned = json_clone(output)
        if isinstance(cloned.get("body"), str):
            cloned["body"] = truncate_text_middle(cloned["body"], max_text_chars)
        elif isinstance(cloned.get("body"), list):
            cloned["body"] = sanitize_function_output_payload(cloned["body"], max_text_chars)
        elif isinstance(cloned.get("content"), list):
            cloned["content"] = sanitize_function_output_payload(cloned["content"], max_text_chars)
        elif isinstance(cloned.get("text"), str):
            cloned["text"] = truncate_text_middle(cloned["text"], max_text_chars)
        return cloned
    return json_clone(output)


def sanitize_input_items_for_probe(items: list[dict[str, Any]], max_text_chars: int) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []
    for item in items:
        cloned = json_clone(item)
        item_type = str(cloned.get("type") or "").strip().lower()
        if item_type in {"function_call_output", "custom_tool_call_output"}:
            cloned["output"] = sanitize_function_output_payload(cloned.get("output"), max_text_chars)
        sanitized.append(cloned)
    return sanitized


def find_next_turn_boundary_index(items: list[dict[str, Any]]) -> int:
    for index in range(1, len(items)):
        item = items[index]
        if item.get("type") == "message" and item.get("role") == "user":
            return index
    return -1


def trim_input_suffix_to_budget(base_request: dict[str, Any], target_bytes: int, max_text_chars: int) -> dict[str, Any]:
    projected = {
        key: json_clone(base_request[key])
        for key in ("model", "input", "instructions", "tools", "parallel_tool_calls", "reasoning", "text")
        if key in base_request
    }
    input_items = sanitize_input_items_for_probe(list(projected.get("input") or []), max_text_chars)
    projected["input"] = input_items

    while len(projected["input"]) > 1 and estimate_bytes(projected) > target_bytes:
        boundary_index = find_next_turn_boundary_index(projected["input"])
        if boundary_index > 0:
            projected["input"] = projected["input"][boundary_index:]
        else:
            projected["input"] = projected["input"][1:]

    return projected


def summarize_request_body(body: dict[str, Any]) -> dict[str, Any]:
    instructions = body.get("instructions")
    visible_text = "\n".join(extract_visible_text_segments(body))
    function_output_bytes = 0
    function_output_count = 0
    for item in body.get("input") or []:
        item_type = str(item.get("type") or "").strip().lower()
        if item_type not in {"function_call_output", "custom_tool_call_output"}:
            continue
        function_output_count += 1
        function_output_bytes += estimate_bytes(item.get("output"))

    return {
        "request_bytes": estimate_bytes(body),
        "input_count": len(body.get("input") or []),
        "instructions_chars": len(instructions) if isinstance(instructions, str) else 0,
        "visible_text_chars": len(visible_text),
        "approx_json_tokens_o200k": count_tokens(json.dumps(body, ensure_ascii=False, separators=(",", ":"))),
        "approx_visible_text_tokens_o200k": count_tokens(visible_text),
        "function_call_output_count": function_output_count,
        "function_call_output_bytes": function_output_bytes,
        "first_input_type": (body.get("input") or [{}])[0].get("type") if body.get("input") else None,
        "first_input_role": (body.get("input") or [{}])[0].get("role") if body.get("input") else None,
        "last_input_type": (body.get("input") or [{}])[-1].get("type") if body.get("input") else None,
        "last_input_role": (body.get("input") or [{}])[-1].get("role") if body.get("input") else None,
    }


def post_compact_request(url: str, api_key: str, body: dict[str, Any], timeout_seconds: int) -> dict[str, Any]:
    payload_bytes = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload_bytes,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    started_at = time.time()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            raw_bytes = response.read()
            ended_at = time.time()
            raw_text = raw_bytes.decode("utf-8", errors="replace")
            result = {
                "status": response.status,
                "ok": 200 <= int(response.status) < 300,
                "duration_ms": round((ended_at - started_at) * 1000, 1),
                "response_bytes": len(raw_bytes),
                "content_type": response.headers.get("Content-Type", ""),
                "content_length_header": response.headers.get("Content-Length", ""),
                "json_ok": False,
                "output_count": None,
                "error_message": None,
                "response_preview": raw_text[:400],
            }
            if raw_text.strip():
                try:
                    parsed = json.loads(raw_text)
                    result["json_ok"] = True
                    if isinstance(parsed, dict) and isinstance(parsed.get("output"), list):
                        result["output_count"] = len(parsed["output"])
                    if isinstance(parsed, dict) and isinstance(parsed.get("usage"), dict):
                        result["usage"] = parsed["usage"]
                    if isinstance(parsed, dict) and parsed.get("error"):
                        result["response_error"] = parsed["error"]
                except Exception as exc:  # pragma: no cover
                    result["error_message"] = f"json_parse_failed: {exc}"
            else:
                result["error_message"] = "empty_response_body"
            return result
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return {
            "status": int(exc.code),
            "ok": False,
            "duration_ms": round((time.time() - started_at) * 1000, 1),
            "response_bytes": len(raw),
            "content_type": exc.headers.get("Content-Type", ""),
            "content_length_header": exc.headers.get("Content-Length", ""),
            "json_ok": False,
            "output_count": None,
            "error_message": f"http_error: {exc}",
            "response_preview": raw.decode("utf-8", errors="replace")[:400],
        }
    except Exception as exc:  # pragma: no cover
        return {
            "status": None,
            "ok": False,
            "duration_ms": round((time.time() - started_at) * 1000, 1),
            "response_bytes": 0,
            "content_type": "",
            "content_length_header": "",
            "json_ok": False,
            "output_count": None,
            "error_message": f"request_failed: {exc}",
            "response_preview": "",
        }


def build_probe_variants(base_request: dict[str, Any], codex_base_instructions: str) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    for instructions_mode in ("codex_base", "dropped"):
        for target_bytes in TARGET_REQUEST_BYTES:
            body = trim_input_suffix_to_budget(
                base_request=base_request,
                target_bytes=target_bytes,
                max_text_chars=12_000,
            )
            if instructions_mode == "codex_base":
                body = json_clone(body)
                body["instructions"] = codex_base_instructions
            elif instructions_mode == "dropped":
                body = json_clone(body)
                body.pop("instructions", None)
            variants.append(
                {
                    "id": f"{instructions_mode}_{target_bytes}",
                    "instructions_mode": instructions_mode,
                    "target_request_bytes": target_bytes,
                    "body": body,
                }
            )
    deduped: list[dict[str, Any]] = []
    seen_signatures: set[tuple[str, int, int]] = set()
    for variant in variants:
        summary = summarize_request_body(variant["body"])
        signature = (
            variant["instructions_mode"],
            summary["request_bytes"],
            summary["input_count"],
        )
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        variant["summary"] = summary
        deduped.append(variant)
    return deduped


def run_probe(repo_root: Path, har_path: Path, output_dir: Path, timeout_seconds: int, skip_network: bool) -> dict[str, Any]:
    fixed_env = load_fixed_api_env(repo_root)
    har_url, har_request_body = read_har_compact_request(har_path)
    codex_base_instructions = load_codex_base_instructions(repo_root)
    base_url = fixed_env["responses_base_url"].rstrip("/")
    probe_url = f"{base_url}/compact" if not base_url.endswith("/compact") else base_url
    variants = build_probe_variants(har_request_body, codex_base_instructions)
    variants_dir = output_dir / "variants"
    variants_dir.mkdir(parents=True, exist_ok=True)

    result: dict[str, Any] = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "repo_root": str(repo_root),
        "har_path": str(har_path),
        "har_url": har_url,
        "probe_url": probe_url,
        "codex_base_instructions_chars": len(codex_base_instructions),
        "variant_count": len(variants),
        "variants": [],
    }

    for index, variant in enumerate(variants, start=1):
        body_path = variants_dir / f"{variant['id']}.json"
        body_path.write_text(json.dumps(variant["body"], ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            f"[{index}/{len(variants)}] probe {variant['id']} "
            f"bytes={variant['summary']['request_bytes']} "
            f"approx_visible_tokens={variant['summary']['approx_visible_text_tokens_o200k']}",
            flush=True,
        )
        network_result = None if skip_network else post_compact_request(
            url=probe_url,
            api_key=fixed_env["responses_api_key"],
            body=variant["body"],
            timeout_seconds=timeout_seconds,
        )
        result["variants"].append(
            {
                "id": variant["id"],
                "instructions_mode": variant["instructions_mode"],
                "target_request_bytes": variant["target_request_bytes"],
                "body_path": str(body_path),
                "request_summary": variant["summary"],
                "network_result": network_result,
            }
        )

    result["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return result


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--har-path", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=90)
    parser.add_argument("--skip-network", action="store_true")
    args = parser.parse_args(list(argv) if argv is not None else None)

    repo_root = Path(args.repo_root).resolve()
    har_path = Path(args.har_path).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    result = run_probe(
        repo_root=repo_root,
        har_path=har_path,
        output_dir=output_dir,
        timeout_seconds=args.timeout_seconds,
        skip_network=args.skip_network,
    )
    result_path = output_dir / "result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"result_path": str(result_path), "variant_count": result["variant_count"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

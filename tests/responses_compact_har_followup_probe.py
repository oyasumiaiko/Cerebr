#!/usr/bin/env python3
"""
基于“裁剪后的 HAR compact 请求体”验证：
1. `/responses/compact` 是否成功返回可重放 output；
2. 把 compact output 作为下一轮 `/responses` 的历史输入后，
   模型是否还能回答出前文里已经出现过的事实。

设计说明：
- 这里只验证“compact 产物是否足以支撑后续追问”，不走 Cerebr UI；
- 输入直接来自已经裁剪好的 variant body JSON，避免再次引入另一套裁剪分支；
- follow-up 问题使用来自 HAR 对话前文的真实事实点，而不是人造 codeword。
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable


def parse_dotenv(content: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw_line in str(content or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        value = raw_value.strip()
        if len(value) >= 2 and (
            (value.startswith('"') and value.endswith('"'))
            or (value.startswith("'") and value.endswith("'"))
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
        "responses_base_url": base_url.rstrip("/"),
        "responses_api_key": api_key,
    }


def json_clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def estimate_bytes(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def post_json(url: str, api_key: str, body: dict[str, Any], timeout_seconds: int) -> dict[str, Any]:
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
            raw_text = raw_bytes.decode("utf-8", errors="replace")
            duration_ms = round((time.time() - started_at) * 1000, 1)
            parsed = None
            json_ok = False
            json_error = ""
            if raw_text.strip():
                try:
                    parsed = json.loads(raw_text)
                    json_ok = True
                except Exception as exc:
                    json_error = str(exc)
            return {
                "status": int(response.status),
                "ok": 200 <= int(response.status) < 300,
                "duration_ms": duration_ms,
                "request_bytes": len(payload_bytes),
                "response_bytes": len(raw_bytes),
                "content_type": response.headers.get("Content-Type", ""),
                "content_length_header": response.headers.get("Content-Length", ""),
                "json_ok": json_ok,
                "json_error": json_error,
                "parsed": parsed,
                "response_preview": raw_text[:1000],
            }
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return {
            "status": int(exc.code),
            "ok": False,
            "duration_ms": round((time.time() - started_at) * 1000, 1),
            "request_bytes": len(payload_bytes),
            "response_bytes": len(raw),
            "content_type": exc.headers.get("Content-Type", ""),
            "content_length_header": exc.headers.get("Content-Length", ""),
            "json_ok": False,
            "json_error": "",
            "parsed": None,
            "response_preview": raw.decode("utf-8", errors="replace")[:1000],
        }
    except Exception as exc:
        return {
            "status": None,
            "ok": False,
            "duration_ms": round((time.time() - started_at) * 1000, 1),
            "request_bytes": len(payload_bytes),
            "response_bytes": 0,
            "content_type": "",
            "content_length_header": "",
            "json_ok": False,
            "json_error": "",
            "parsed": None,
            "response_preview": "",
            "request_error": str(exc),
        }


def extract_text_from_response_output(parsed: Any) -> str:
    if not isinstance(parsed, dict):
        return ""
    output = parsed.get("output")
    if not isinstance(output, list):
        return ""
    segments: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "").strip().lower() != "message":
            continue
        for part in item.get("content") or []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                segments.append(part["text"])
    return "\n".join(segment for segment in segments if segment)


def build_followup_request_body(compact_body: dict[str, Any], compact_output: list[dict[str, Any]], question: str) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": compact_body.get("model"),
        "input": [
            *json_clone(compact_output),
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": question,
                    }
                ],
            },
        ],
        "store": False,
        "stream": False,
        "text": json_clone(compact_body.get("text") or {"verbosity": "low"}),
    }
    if compact_body.get("instructions"):
        body["instructions"] = compact_body["instructions"]
    if isinstance(compact_body.get("reasoning"), dict):
        body["reasoning"] = json_clone(compact_body["reasoning"])
    return body


def build_questions() -> list[dict[str, Any]]:
    return [
        {
            "id": "field_count",
            "question": "根据前文，当前这个配置下字段一共多少个？只回答数字。",
            "expected_substrings": ["2646"],
        },
        {
            "id": "scope",
            "question": "根据前文，当前配置是什么？只回答 instrumentType / region / delay / universe，例如 EQUITY / USA / D1 / TOP3000。",
            "expected_substrings": ["EQUITY / USA / D1 / TOP3000", "EQUITY/USA/D1/TOP3000"],
        },
    ]


def run_probe(
    repo_root: Path,
    variant_body_paths: list[Path],
    output_dir: Path,
    timeout_seconds: int,
) -> dict[str, Any]:
    env = load_fixed_api_env(repo_root)
    compact_url = f"{env['responses_base_url']}/compact"
    responses_url = env["responses_base_url"]
    questions = build_questions()
    output_dir.mkdir(parents=True, exist_ok=True)

    result: dict[str, Any] = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "repo_root": str(repo_root),
        "compact_url": compact_url,
        "responses_url": responses_url,
        "variant_count": len(variant_body_paths),
        "questions": questions,
        "variants": [],
    }

    for index, body_path in enumerate(variant_body_paths, start=1):
        compact_body = json.loads(body_path.read_text(encoding="utf-8"))
        variant_id = body_path.stem
        variant_dir = output_dir / variant_id
        variant_dir.mkdir(parents=True, exist_ok=True)
        print(f"[{index}/{len(variant_body_paths)}] compact {variant_id} bytes={estimate_bytes(compact_body)}", flush=True)

        compact_result = post_json(
            url=compact_url,
            api_key=env["responses_api_key"],
            body=compact_body,
            timeout_seconds=timeout_seconds,
        )
        (variant_dir / "compact_request.json").write_text(
            json.dumps(compact_body, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (variant_dir / "compact_result.json").write_text(
            json.dumps(compact_result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        compact_output = []
        if isinstance(compact_result.get("parsed"), dict) and isinstance(compact_result["parsed"].get("output"), list):
            compact_output = json_clone(compact_result["parsed"]["output"])

        followups: list[dict[str, Any]] = []
        if compact_result.get("ok") and compact_result.get("json_ok") and compact_output:
            for question in questions:
                followup_body = build_followup_request_body(compact_body, compact_output, question["question"])
                followup_result = post_json(
                    url=responses_url,
                    api_key=env["responses_api_key"],
                    body=followup_body,
                    timeout_seconds=timeout_seconds,
                )
                answer_text = extract_text_from_response_output(followup_result.get("parsed"))
                followup_entry = {
                    "id": question["id"],
                    "question": question["question"],
                    "expected_substrings": question["expected_substrings"],
                    "request_bytes": estimate_bytes(followup_body),
                    "response": {
                        "status": followup_result.get("status"),
                        "ok": followup_result.get("ok"),
                        "duration_ms": followup_result.get("duration_ms"),
                        "response_bytes": followup_result.get("response_bytes"),
                        "json_ok": followup_result.get("json_ok"),
                        "response_preview": followup_result.get("response_preview"),
                    },
                    "answer_text": answer_text,
                    "matched": any(expected in answer_text for expected in question["expected_substrings"]),
                }
                followups.append(followup_entry)
                (variant_dir / f"followup_{question['id']}_request.json").write_text(
                    json.dumps(followup_body, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                (variant_dir / f"followup_{question['id']}_result.json").write_text(
                    json.dumps(
                        {
                            **followup_result,
                            "answer_text": answer_text,
                            "matched": followup_entry["matched"],
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )

        result["variants"].append(
            {
                "id": variant_id,
                "body_path": str(body_path),
                "compact_request_bytes": estimate_bytes(compact_body),
                "compact_result": {
                    "status": compact_result.get("status"),
                    "ok": compact_result.get("ok"),
                    "duration_ms": compact_result.get("duration_ms"),
                    "response_bytes": compact_result.get("response_bytes"),
                    "json_ok": compact_result.get("json_ok"),
                    "output_count": len(compact_output),
                    "response_preview": compact_result.get("response_preview"),
                },
                "followups": followups,
            }
        )

    result["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return result


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--variant-body-path", action="append", required=True)
    args = parser.parse_args(list(argv) if argv is not None else None)

    repo_root = Path(args.repo_root).resolve()
    output_dir = Path(args.output_dir).resolve()
    variant_body_paths = [Path(item).resolve() for item in args.variant_body_path]

    result = run_probe(
        repo_root=repo_root,
        variant_body_paths=variant_body_paths,
        output_dir=output_dir,
        timeout_seconds=args.timeout_seconds,
    )
    result_path = output_dir / "result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"result_path": str(result_path), "variant_count": len(result["variants"])}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

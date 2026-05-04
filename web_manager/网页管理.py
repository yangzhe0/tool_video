from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
import shutil
import threading
import time
import zlib
from io import BytesIO
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.utils import safe_join

try:
    from PIL import Image, ImageOps
except ImportError:
    Image = None
    ImageOps = None


PROJECT_DIR = Path(__file__).resolve().parent
DRIVE_ROOT = PROJECT_DIR.parent
ROOT_CONFIG_PATH = DRIVE_ROOT / "配置.json"

def load_root_config() -> dict[str, str]:
    if not ROOT_CONFIG_PATH.exists():
        return {}
    try:
        payload = json.loads(ROOT_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {str(key): str(value) for key, value in payload.items() if isinstance(value, str)}


def resolve_root_path(value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path.resolve()
    return (DRIVE_ROOT / path).resolve()


ROOT_CONFIG = load_root_config()

MEDIA_DIR = resolve_root_path(os.environ.get("VIDEO_LIBRARY_DIR") or ROOT_CONFIG.get("资源库", "./library"))
DELETE_DIR = resolve_root_path(os.environ.get("VIDEO_DELETE_DIR") or ROOT_CONFIG.get("回收站", "./recycle_bin"))

app = Flask(
    __name__,
    template_folder=str(PROJECT_DIR / "templates"),
    static_folder=str(PROJECT_DIR / "static"),
)

VIDEO_EXTENSIONS = {".mp4"}
THUMB_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
DEFAULT_PAGE_SIZE = 24
MAX_PAGE_SIZE = 60
CACHE_TTL_SECONDS = 10
THUMB_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
MEDIA_MAX_AGE_SECONDS = 60 * 5
DURATION_CACHE_PATH = PROJECT_DIR / "cache" / "durations.json"
FFPROBE_PATH = Path(
    os.environ.get("VIDEO_FFPROBE_PATH", DRIVE_ROOT / "video_processor" / "FFmpeg" / "ffprobe.exe")
).resolve()

_VIDEO_CACHE: dict[str, object] = {"expires_at": 0.0, "items": []}
_DURATION_CACHE_LOCK = threading.Lock()
_DURATION_CACHE: dict[str, object] = {"loaded": False, "items": {}}


def ensure_runtime_dirs() -> None:
    DELETE_DIR.mkdir(parents=True, exist_ok=True)
    DURATION_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)


def detect_lan_ips() -> list[str]:
    candidates: list[str] = []

    try:
        output = subprocess.check_output(
            ["ipconfig"],
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        candidates.extend(re.findall(r"IPv4[^\:]*:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)", output))
    except (OSError, subprocess.SubprocessError):
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if ip:
                candidates.append(ip)
    except OSError:
        pass

    valid_ips: list[str] = []
    seen: set[str] = set()

    for ip in candidates:
        try:
            parsed = ipaddress.ip_address(ip)
        except ValueError:
            continue

        if parsed.is_loopback or parsed.is_link_local:
            continue

        if ip not in seen:
            valid_ips.append(ip)
            seen.add(ip)

    def priority(ip: str) -> tuple[int, str]:
        if ip.startswith("192.168."):
            return (0, ip)
        if ip.startswith("172."):
            try:
                second = int(ip.split(".")[1])
            except (IndexError, ValueError):
                second = 0
            if 16 <= second <= 31:
                return (1, ip)
        if ip.startswith("10."):
            return (2, ip)
        return (3, ip)

    return sorted(valid_ips, key=priority)


def clear_video_cache() -> None:
    _VIDEO_CACHE["expires_at"] = 0.0
    _VIDEO_CACHE["items"] = []


def load_duration_cache() -> dict[str, float]:
    with _DURATION_CACHE_LOCK:
        if _DURATION_CACHE["loaded"]:
            return dict(_DURATION_CACHE["items"])

        items: dict[str, float] = {}
        if DURATION_CACHE_PATH.exists():
            try:
                payload = json.loads(DURATION_CACHE_PATH.read_text(encoding="utf-8"))
                raw_items = payload.get("items", {})
                if isinstance(raw_items, dict):
                    items = {
                        str(key): float(value)
                        for key, value in raw_items.items()
                        if isinstance(key, str)
                    }
            except (OSError, ValueError, TypeError):
                items = {}

        _DURATION_CACHE["items"] = items
        _DURATION_CACHE["loaded"] = True
        return dict(items)


def save_duration_cache(items: dict[str, float]) -> None:
    normalized = {str(key): float(value) for key, value in items.items()}
    payload = {"items": normalized, "updated_at": time.time()}
    DURATION_CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    with _DURATION_CACHE_LOCK:
        _DURATION_CACHE["items"] = normalized
        _DURATION_CACHE["loaded"] = True


def update_duration_entry(old_relative: str | None, new_relative: str | None, duration: float | None = None) -> None:
    items = load_duration_cache()
    if old_relative and old_relative in items:
        current_duration = items.pop(old_relative)
        if new_relative:
            items[new_relative] = float(duration if duration is not None else current_duration)
            save_duration_cache(items)
            return
    elif new_relative and duration is not None:
        items[new_relative] = float(duration)
        save_duration_cache(items)
        return

    if old_relative:
        save_duration_cache(items)


def probe_video_duration(video_path: Path) -> float:
    if not FFPROBE_PATH.exists():
        raise FileNotFoundError(f"找不到 ffprobe: {FFPROBE_PATH}")

    result = subprocess.run(
        [
            str(FFPROBE_PATH),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"ffprobe 返回码 {result.returncode}")

    output = result.stdout.strip()
    try:
        return max(0.0, float(output))
    except ValueError as exc:
        raise RuntimeError(f"无法解析时长: {output}") from exc


def derive_category(relative_path: str, file_name: str) -> str:
    folder = relative_path.split("/", 1)[0]
    prefix = file_name.split(" ")[0].replace("#", "").strip()
    return prefix or folder or "未分类"


def sortable_name(item: dict[str, object]) -> str:
    name = str(item["name"])
    stem = Path(name).stem.strip()
    category = str(item.get("category", "")).strip()
    match = re.match(r"^(\S+)(\s+)(.*)$", stem)

    if match:
        prefix = match.group(1).replace("#", "").strip()
        remainder = match.group(3).strip()
        if prefix and category and prefix == category and remainder:
            return remainder.casefold()

    return stem.casefold()


def build_thumbnail_path(video_path: Path) -> Path | None:
    for extension in THUMB_EXTENSIONS:
        candidate = video_path.with_suffix(extension)
        if candidate.exists():
            return candidate
    return None


def scan_videos() -> list[dict[str, object]]:
    now = time.time()
    if _VIDEO_CACHE["items"] and now < float(_VIDEO_CACHE["expires_at"]):
        return list(_VIDEO_CACHE["items"])

    if not MEDIA_DIR.exists():
        return []

    items: list[dict[str, object]] = []
    duration_cache = load_duration_cache()

    for path in MEDIA_DIR.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in VIDEO_EXTENSIONS:
            continue

        stat = path.stat()
        relative_path = path.relative_to(MEDIA_DIR).as_posix()
        thumbnail_path = build_thumbnail_path(path)
        thumbnail_modified_time = thumbnail_path.stat().st_mtime if thumbnail_path else None
        duration = float(duration_cache.get(relative_path, 0.0) or 0.0)

        items.append(
            {
                "name": path.name,
                "path": relative_path,
                "folder": path.parent.relative_to(MEDIA_DIR).as_posix(),
                "size": stat.st_size,
                "category": derive_category(relative_path, path.name),
                "modified_time": stat.st_mtime,
                "duration": duration,
                "thumbnail": thumbnail_path.relative_to(MEDIA_DIR).as_posix()
                if thumbnail_path
                else None,
                "thumbnail_modified_time": thumbnail_modified_time,
            }
        )

    items.sort(key=lambda item: float(item["modified_time"]), reverse=True)
    _VIDEO_CACHE["items"] = items
    _VIDEO_CACHE["expires_at"] = now + CACHE_TTL_SECONDS
    return list(items)


def paginate(items: list[dict[str, object]], page: int, page_size: int) -> dict[str, object]:
    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "items": items[start:end],
        "page": page,
        "page_size": page_size,
        "total": total,
        "has_more": end < total,
        "total_pages": (total + page_size - 1) // page_size if total else 0,
    }


def sort_videos(items: list[dict[str, object]], sort_key: str, random_seed: str = "") -> list[dict[str, object]]:
    if sort_key == "name":
        return sorted(items, key=lambda item: (sortable_name(item), str(item["name"]).casefold()))
    if sort_key == "size":
        return sorted(items, key=lambda item: (int(item["size"]), str(item["name"]).casefold()), reverse=True)
    if sort_key == "duration":
        return sorted(items, key=lambda item: (float(item.get("duration", 0.0)), str(item["name"]).casefold()), reverse=True)
    if sort_key == "random":
        seed = random_seed or str(int(time.time() * 1000))
        return sorted(
            items,
            key=lambda item: (
                zlib.crc32(f"{seed}:{item['path']}".encode("utf-8", errors="ignore")),
                str(item["name"]).casefold(),
            ),
        )
    return sorted(items, key=lambda item: float(item["modified_time"]), reverse=True)


def build_stats(items: list[dict[str, object]]) -> dict[str, object]:
    return {
        "video_count": len(items),
        "total_size": sum(int(item["size"]) for item in items),
        "category_count": len({str(item["category"]) for item in items}),
    }


def resolve_media_path(relative_path: str) -> Path | None:
    safe_path = safe_join(str(MEDIA_DIR), relative_path)
    if safe_path is None:
        return None
    return Path(safe_path)


def resolve_delete_path(relative_path: str) -> Path | None:
    safe_path = safe_join(str(DELETE_DIR), relative_path)
    if safe_path is None:
        return None
    return Path(safe_path)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/videos")
def list_videos():
    if not MEDIA_DIR.exists():
        return jsonify({"error": f"找不到视频目录: {MEDIA_DIR}"}), 404

    try:
        page = max(int(request.args.get("page", 1)), 1)
        page_size = min(max(int(request.args.get("page_size", DEFAULT_PAGE_SIZE)), 1), MAX_PAGE_SIZE)
    except ValueError:
        return jsonify({"error": "分页参数无效"}), 400

    query = request.args.get("q", "").strip().casefold()
    sort_key = request.args.get("sort", "time").strip().lower()
    random_seed = request.args.get("random_seed", "").strip()
    categories = [value.strip() for value in request.args.getlist("category") if value.strip()]
    items = scan_videos()
    if categories:
        selected = set(categories)
        items = [item for item in items if item["category"] in selected]
    if query:
        items = [
            item
            for item in items
            if query in str(item["name"]).casefold()
            or query in str(item["category"]).casefold()
            or query in str(item["folder"]).casefold()
        ]
    items = sort_videos(items, sort_key, random_seed)

    payload = paginate(items, page, page_size)
    payload["stats"] = build_stats(items)
    payload["filters"] = {"categories": categories, "q": query, "sort": sort_key}
    payload["generated_at"] = time.time()
    return jsonify(payload)


@app.route("/api/categories")
def list_categories():
    counts: dict[str, int] = {}
    for item in scan_videos():
        category = str(item["category"])
        counts[category] = counts.get(category, 0) + 1

    items = [
        {"name": key, "count": value}
        for key, value in sorted(counts.items(), key=lambda item: (-item[1], item[0].casefold()))
    ]
    return jsonify({"items": items})


@app.route("/api/durations/rebuild", methods=["POST"])
def rebuild_durations():
    if not MEDIA_DIR.exists():
        return jsonify({"error": f"找不到视频目录: {MEDIA_DIR}"}), 404

    try:
        items: dict[str, float] = {}
        failed: list[str] = []
        total = 0

        for path in MEDIA_DIR.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in VIDEO_EXTENSIONS:
                continue
            total += 1
            relative_path = path.relative_to(MEDIA_DIR).as_posix()
            try:
                items[relative_path] = probe_video_duration(path)
            except Exception:
                items[relative_path] = 0.0
                failed.append(relative_path)

        save_duration_cache(items)
        clear_video_cache()
        return jsonify(
            {
                "success": True,
                "total": total,
                "updated": len(items) - len(failed),
                "failed": len(failed),
            }
        )
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 500
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/delete", methods=["POST"])
def delete_video():
    data = request.get_json(silent=True) or {}
    relative_path = data.get("name", "").strip()
    if not relative_path:
        return jsonify({"error": "未提供文件名"}), 400

    source_path = resolve_media_path(relative_path)
    destination_path = resolve_delete_path(relative_path)
    if source_path is None or destination_path is None:
        return jsonify({"error": "非法路径"}), 400

    try:
        if not source_path.exists():
            return jsonify({"error": "找不到源文件"}), 404

        ensure_runtime_dirs()
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source_path), str(destination_path))

        base_src = source_path.with_suffix("")
        base_dst = destination_path.with_suffix("")
        for extension in THUMB_EXTENSIONS:
            thumb_src = base_src.with_suffix(extension)
            if thumb_src.exists():
                thumb_dst = base_dst.with_suffix(extension)
                thumb_dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(thumb_src), str(thumb_dst))

        update_duration_entry(relative_path, None)
        clear_video_cache()
        return jsonify({"success": True, "message": "文件已移至回收站"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/rename", methods=["POST"])
def rename_video():
    data = request.get_json(silent=True) or {}
    old_relative = data.get("oldName", "").strip()
    new_relative = data.get("newName", "").strip()
    if not old_relative or not new_relative:
        return jsonify({"error": "缺少重命名参数"}), 400

    old_path = resolve_media_path(old_relative)
    new_path = resolve_media_path(new_relative)
    if old_path is None or new_path is None:
        return jsonify({"error": "非法路径"}), 400
    if old_path.parent != new_path.parent:
        return jsonify({"error": "当前版本仅支持在同一目录内重命名"}), 400

    try:
        if not old_path.exists():
            return jsonify({"error": "找不到源文件"}), 404
        if new_path.exists():
            return jsonify({"error": "目标文件已存在"}), 409

        os.rename(old_path, new_path)
        base_old = old_path.with_suffix("")
        base_new = new_path.with_suffix("")
        for extension in THUMB_EXTENSIONS:
            thumb_old = base_old.with_suffix(extension)
            if thumb_old.exists():
                os.rename(thumb_old, base_new.with_suffix(extension))

        update_duration_entry(old_relative, new_relative)
        clear_video_cache()
        return jsonify({"success": True})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/media/<path:filename>")
def serve_video(filename: str):
    video_path = resolve_media_path(filename)
    if video_path is None or not video_path.exists():
        return "Video Not Found", 404
    return send_file(
        video_path,
        mimetype="video/mp4",
        as_attachment=False,
        conditional=True,
        max_age=MEDIA_MAX_AGE_SECONDS,
    )


@app.route("/thumbnail/<path:filename>")
def serve_thumbnail(filename: str):
    source_path = resolve_media_path(filename)
    if source_path is None or not source_path.exists():
        return "Thumbnail Not Found", 404

    try:
        target_width = min(max(int(request.args.get("w", "480")), 120), 800)
    except ValueError:
        return "Invalid width", 400

    if Image is None or ImageOps is None:
        return send_file(source_path, conditional=True, max_age=THUMB_MAX_AGE_SECONDS)

    with Image.open(source_path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((target_width, target_width * 2))
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=72, optimize=True)
        buffer.seek(0)

    return send_file(
        buffer,
        mimetype="image/jpeg",
        conditional=True,
        max_age=THUMB_MAX_AGE_SECONDS,
    )


if __name__ == "__main__":
    ensure_runtime_dirs()
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    lan_ips = detect_lan_ips()
    print("本地视频网页管理已启动")
    print(f"视频目录: {MEDIA_DIR}")
    print("电脑访问: http://127.0.0.1:5000")
    if lan_ips:
        print("手机访问候选地址:")
        for ip in lan_ips:
            print(f"  http://{ip}:5000")
    else:
        print("手机访问: 未能自动识别，请手动执行 ipconfig 查看电脑 IPv4")
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)

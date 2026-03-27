from __future__ import annotations

import hashlib
import ipaddress
import os
import re
import socket
import subprocess
import shutil
import time
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

MEDIA_DIR = Path(os.environ.get("VIDEO_LIBRARY_DIR", DRIVE_ROOT / "static")).resolve()
DELETE_DIR = Path(os.environ.get("VIDEO_DELETE_DIR", DRIVE_ROOT / "delete")).resolve()
THUMB_CACHE_DIR = Path(
    os.environ.get("VIDEO_THUMB_CACHE_DIR", PROJECT_DIR / "cache" / "thumbs")
).resolve()

app = Flask(
    __name__,
    template_folder=str(PROJECT_DIR / "views"),
    static_folder=str(PROJECT_DIR / "web_static"),
)

VIDEO_EXTENSIONS = {".mp4"}
THUMB_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
DEFAULT_PAGE_SIZE = 24
MAX_PAGE_SIZE = 60
CACHE_TTL_SECONDS = 10
THUMB_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
MEDIA_MAX_AGE_SECONDS = 60 * 5

_VIDEO_CACHE: dict[str, object] = {"expires_at": 0.0, "items": []}


def ensure_runtime_dirs() -> None:
    DELETE_DIR.mkdir(parents=True, exist_ok=True)
    THUMB_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def detect_lan_ip() -> str | None:
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

    for ip in candidates:
        try:
            parsed = ipaddress.ip_address(ip)
        except ValueError:
            continue

        if parsed.is_loopback or parsed.is_link_local:
            continue

        if ip.startswith("192.168.") or ip.startswith("10."):
            return ip

        if ip.startswith("172."):
            second = int(ip.split(".")[1])
            if 16 <= second <= 31:
                return ip

    for ip in candidates:
        try:
            parsed = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if not parsed.is_loopback and not parsed.is_link_local:
            return ip

    return None


def clear_video_cache() -> None:
    _VIDEO_CACHE["expires_at"] = 0.0
    _VIDEO_CACHE["items"] = []


def derive_category(relative_path: str, file_name: str) -> str:
    folder = relative_path.split("/", 1)[0]
    prefix = file_name.split(" ")[0].replace("#", "").strip()
    return prefix or folder or "未分类"


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

    for path in MEDIA_DIR.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in VIDEO_EXTENSIONS:
            continue

        stat = path.stat()
        relative_path = path.relative_to(MEDIA_DIR).as_posix()
        thumbnail_path = build_thumbnail_path(path)

        items.append(
            {
                "name": path.name,
                "path": relative_path,
                "folder": path.parent.relative_to(MEDIA_DIR).as_posix(),
                "size": stat.st_size,
                "category": derive_category(relative_path, path.name),
                "modified_time": stat.st_mtime,
                "thumbnail": thumbnail_path.relative_to(MEDIA_DIR).as_posix()
                if thumbnail_path
                else None,
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

    category = request.args.get("category", "").strip()
    items = scan_videos()
    if category:
        items = [item for item in items if item["category"] == category]

    payload = paginate(items, page, page_size)
    payload["stats"] = build_stats(items)
    payload["filters"] = {"category": category}
    payload["generated_at"] = time.time()
    return jsonify(payload)


@app.route("/api/categories")
def list_categories():
    counts: dict[str, int] = {}
    for item in scan_videos():
        category = str(item["category"])
        counts[category] = counts.get(category, 0) + 1

    items = [{"name": key, "count": counts[key]} for key in sorted(counts)]
    return jsonify({"items": items})


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

    ensure_runtime_dirs()
    stat = source_path.stat()
    cache_key = hashlib.sha1(
        f"{source_path}:{stat.st_mtime}:{target_width}".encode("utf-8")
    ).hexdigest()
    cache_path = THUMB_CACHE_DIR / f"{cache_key}.jpg"

    if not cache_path.exists():
        with Image.open(source_path) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((target_width, target_width * 2))
            image.save(cache_path, format="JPEG", quality=72, optimize=True)

    return send_file(
        cache_path,
        mimetype="image/jpeg",
        conditional=True,
        max_age=THUMB_MAX_AGE_SECONDS,
    )


if __name__ == "__main__":
    ensure_runtime_dirs()
    lan_ip = detect_lan_ip()
    print("--- 视频管理系统启动 ---")
    print(f"项目路径: {PROJECT_DIR}")
    print(f"视频目录: {MEDIA_DIR}")
    print(f"删除目录: {DELETE_DIR}")
    print("本机访问: http://127.0.0.1:5000")
    if lan_ip:
        print(f"局域网访问: http://{lan_ip}:5000")
    else:
        print("局域网访问: 未能自动识别，请手动执行 ipconfig 确认可用 IPv4")
    app.run(host="0.0.0.0", port=5000, debug=True)

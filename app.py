from __future__ import annotations

import io
import json
import os
import queue
import shutil
import subprocess
import threading
import time
import uuid
import webbrowser
import zipfile
import re
from urllib.parse import parse_qs, urlparse
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file, send_from_directory
from PIL import Image
from werkzeug.utils import secure_filename

from processor import BackgroundRemover, make_preview


APP_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = APP_DIR / "outputs"
JOB_DIR = OUTPUT_DIR / "jobs"
HOME_DELIVERY_DIR = Path.home() / "Desktop" / "BG-Received"
CONFIG_DIR = APP_DIR / "config"
SHARE_URL_FILE = CONFIG_DIR / "share_url.txt"
CLIENTS_FILE = CONFIG_DIR / "clients.json"
CLIENT_ONLINE_SECONDS = 30
MODEL_PATH_ENV = os.environ.get("MODEL_PATH")
if MODEL_PATH_ENV:
    MODEL_PATH = Path(MODEL_PATH_ENV)
elif (APP_DIR / "models" / "BEN2_Base.onnx").exists():
    MODEL_PATH = APP_DIR / "models" / "BEN2_Base.onnx"
else:
    MODEL_PATH = Path(r"C:\Users\lenovo\Documents\Donut\.bgremove-models\BEN2_Base.onnx")
RCLONE_EXE = Path(r"C:\Users\lenovo\AppData\Local\Microsoft\WinGet\Packages\Rclone.Rclone_Microsoft.Winget.Source_8wekyb3d8bbwe\rclone-v1.75.0-windows-amd64\rclone.exe")
RCLONE_CONFIG = Path(r"C:\Users\lenovo\Documents\Donut\bg-remover-rclone.conf")
ALLOWED = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
JOB_DIR.mkdir(parents=True, exist_ok=True)
HOME_DELIVERY_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 120 * 1024 * 1024
app.config["TEMPLATES_AUTO_RELOAD"] = True
remover = BackgroundRemover(MODEL_PATH)
tunnel_process = None
tunnel_url = ""
tunnel_lock = threading.Lock()
job_queue = queue.Queue(maxsize=100)
queue_lock = threading.Lock()
pending_job_ids = []
current_job_id = None
cancelled_job_ids = set()
jobs_by_id = {}
client_lock = threading.Lock()
job_catalog_lock = threading.Lock()
job_catalog = {}
status_write_lock = threading.Lock()
job_edit_lock = threading.Lock()


def load_clients() -> dict:
    try:
        data = json.loads(CLIENTS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


clients = load_clients()


def clean_client_id(value: str) -> str:
    value = str(value or "").strip().lower()
    return value if re.fullmatch(r"[a-z0-9-]{10,80}", value) else ""


def clean_nickname(value: str) -> str:
    value = re.sub(r"[\x00-\x1f<>]", "", str(value or "")).strip()
    return value[:30]


def save_clients() -> None:
    temporary = CLIENTS_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(clients, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(CLIENTS_FILE)


def ensure_client(client_id: str, nickname: str = "") -> dict:
    client_id = clean_client_id(client_id)
    if not client_id:
        return {"client_id": "", "number": 0, "nickname": "", "display_name": "ผู้ใช้ไม่ระบุเครื่อง"}
    nickname = clean_nickname(nickname)
    now = time.time()
    with queue_lock:
        busy_client_ids = {
            job.get("client_id", "") for job in jobs_by_id.values()
            if job and job.get("client_id")
        }
    with client_lock:
        profile = clients.get(client_id)
        occupied_numbers = {
            int(item.get("number", 0))
            for other_id, item in clients.items()
            if other_id != client_id and int(item.get("number", 0)) > 0 and (
                float(item.get("last_seen", 0)) >= now - CLIENT_ONLINE_SECONDS or
                other_id in busy_client_ids
            )
        }
        changed = False
        if not profile:
            profile = {"number": 0, "nickname": "", "last_seen": 0}
            clients[client_id] = profile
            changed = True
        current_number = int(profile.get("number", 0))
        if current_number <= 0 or current_number in occupied_numbers:
            current_number = 1
            while current_number in occupied_numbers:
                current_number += 1
            profile["number"] = current_number
            changed = True
        if nickname:
            if profile.get("nickname") != nickname:
                profile["nickname"] = nickname
                changed = True
        previous_seen = float(profile.get("last_seen", 0))
        profile["last_seen"] = now
        if changed or now - previous_seen >= 15:
            save_clients()
        number = int(profile["number"])
        saved_nickname = profile.get("nickname", "")
    label = f"{saved_nickname} (เครื่อง {number})" if saved_nickname else f"เครื่องหมายเลข {number}"
    return {"client_id": client_id, "number": number, "nickname": saved_nickname, "display_name": label}


def get_client_profile(client_id: str) -> dict:
    client_id = clean_client_id(client_id)
    now = time.time()
    with client_lock:
        profile = clients.get(client_id, {})
        number = int(profile.get("number", 0))
        nickname = profile.get("nickname", "")
        last_seen = float(profile.get("last_seen", 0))
    if not number:
        return {
            "client_id": client_id,
            "number": 0,
            "nickname": "",
            "display_name": "ผู้ใช้ไม่ระบุเครื่อง",
            "online": False,
        }
    label = f"{nickname} (เครื่อง {number})" if nickname else f"เครื่องหมายเลข {number}"
    return {
        "client_id": client_id,
        "number": number,
        "nickname": nickname,
        "display_name": label,
        "online": last_seen >= now - CLIENT_ONLINE_SECONDS,
    }


def is_remote_request() -> bool:
    if request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For"):
        return True
    return request.remote_addr not in {"127.0.0.1", "::1", None}


def local_only():
    if is_remote_request():
        return jsonify({"ok": False, "error": "คำสั่งนี้ใช้ได้เฉพาะคอมบ้าน"}), 403
    return None


def find_drive_delivery_root() -> Path | None:
    candidates = []
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        root = Path(f"{letter}:\\")
        if not root.exists():
            continue
        candidates.extend([root / "My Drive", root / "ไดรฟ์ของฉัน"])
    candidates.extend([
        Path.home() / "My Drive",
        Path.home() / "Google Drive" / "My Drive",
        Path.home() / "Google Drive" / "ไดรฟ์ของฉัน",
    ])
    for my_drive in candidates:
        target = my_drive / "ลบBG"
        if target.is_dir():
            return target
    return None


def parse_drive_folder_url(value: str) -> tuple[str, str]:
    value = value.strip()
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.netloc not in {"drive.google.com", "www.drive.google.com"}:
        raise ValueError("กรุณาวางลิงก์โฟลเดอร์จาก drive.google.com")
    match = re.search(r"/folders/([A-Za-z0-9_-]+)", parsed.path)
    query = parse_qs(parsed.query)
    folder_id = match.group(1) if match else (query.get("id") or [""])[0]
    resource_key = (query.get("resourcekey") or [""])[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,120}", folder_id):
        raise ValueError("ไม่พบรหัสโฟลเดอร์ในลิงก์ Google Drive")
    if resource_key and not re.fullmatch(r"[A-Za-z0-9_-]{5,200}", resource_key):
        resource_key = ""
    return folder_id, resource_key


def rclone_remote(folder_id: str, resource_key: str = "") -> str:
    options = f"root_folder_id={folder_id}"
    if resource_key:
        options += f",resource_key={resource_key}"
    return f"donutdrive,{options}:"


def run_rclone(arguments: list[str], timeout: int = 180) -> subprocess.CompletedProcess:
    if not RCLONE_EXE.exists() or not RCLONE_CONFIG.exists():
        raise RuntimeError("ระบบ Google Drive ยังเชื่อมต่อไม่สมบูรณ์")
    result = subprocess.run(
        [str(RCLONE_EXE), *arguments, "--config", str(RCLONE_CONFIG)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=0x08000000,
    )
    if result.returncode != 0:
        message = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "Google Drive ไม่ตอบสนอง"
        raise RuntimeError(message)
    return result


def list_drive_images(folder_id: str, resource_key: str = "") -> list[dict]:
    result = run_rclone(["lsjson", rclone_remote(folder_id, resource_key), "--max-depth", "1"])
    items = json.loads(result.stdout or "[]")
    return [
        item for item in items
        if not item.get("IsDir") and Path(item.get("Name", "")).suffix.lower() in ALLOWED
    ]


def safe_image_stem(filename: str) -> str:
    stem = Path(filename).stem
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip(" .")
    return stem or "image"

def cleanup_old_jobs(days: int = 7) -> None:
    cutoff = datetime.now() - timedelta(days=days)
    for path in JOB_DIR.iterdir():
        try:
            if path.is_dir() and datetime.fromtimestamp(path.stat().st_mtime) < cutoff:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


cleanup_old_jobs()


def load_job_catalog() -> None:
    with job_catalog_lock:
        job_catalog.clear()
        for manifest_path in JOB_DIR.glob("*/manifest.json"):
            try:
                item = json.loads(manifest_path.read_text(encoding="utf-8"))
                if isinstance(item, dict) and item.get("job_id"):
                    job_catalog[item["job_id"]] = item
            except (OSError, ValueError):
                continue


def add_job_to_catalog(job: dict) -> None:
    manifest = {
        "job_id": job["job_id"],
        "original_name": job["original_name"],
        "client_id": job.get("client_id", ""),
        "owner_display_name": job.get("owner_display_name", "ผู้ใช้ไม่ระบุเครื่อง"),
        "owner_number": int(job.get("owner_number", 0)),
        "created_at": datetime.now().isoformat(),
    }
    folder = Path(job["folder"])
    (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    with job_catalog_lock:
        job_catalog[job["job_id"]] = manifest


load_job_catalog()


@app.get("/")
def index():
    return render_template("index.html", local_mode=not is_remote_request())


@app.get("/api/health")
def health():
    drive_root = find_drive_delivery_root()
    return jsonify({
        "ok": MODEL_PATH.exists(),
        "offline": True,
        "delivery": {"home": True, "drive": bool(drive_root), "email": False},
    })


@app.post("/api/client/register")
def register_client():
    payload = request.get_json(silent=True) or {}
    client_id = "home-computer" if not is_remote_request() else clean_client_id(payload.get("client_id", ""))
    if not client_id:
        return jsonify({"ok": False, "error": "ไม่พบรหัสประจำเบราว์เซอร์"}), 400
    profile = ensure_client(client_id, payload.get("nickname", ""))
    return jsonify({"ok": True, **profile})


@app.get("/api/queue/status")
def queue_status():
    viewer_id = "home-computer" if not is_remote_request() else clean_client_id(request.args.get("client_id", ""))
    if viewer_id:
        ensure_client(viewer_id)
    with queue_lock:
        active_id = current_job_id
        waiting_ids = list(pending_job_ids)
        active_job = jobs_by_id.get(active_id) if active_id else None
        waiting_jobs = [jobs_by_id.get(job_id) for job_id in waiting_ids]

    def public_owner(job: dict | None) -> dict | None:
        if not job:
            return None
        profile = get_client_profile(job.get("client_id", ""))
        return {
            "client_id": profile["client_id"],
            "display_name": profile["display_name"],
            "number": profile["number"],
            "is_mine": bool(viewer_id and viewer_id == profile["client_id"]),
            "online": profile["online"],
        }

    waiting = []
    for position, job in enumerate(waiting_jobs, start=1):
        owner = public_owner(job)
        if owner:
            waiting.append({"position": position, **owner})
    waiting_groups = []
    for item in waiting:
        if waiting_groups and waiting_groups[-1]["client_id"] == item["client_id"]:
            waiting_groups[-1]["end_position"] = item["position"]
            waiting_groups[-1]["count"] += 1
        else:
            waiting_groups.append({
                **item,
                "start_position": item["position"],
                "end_position": item["position"],
                "count": 1,
            })
    return jsonify({
        "ok": True,
        "busy": bool(active_job),
        "current": public_owner(active_job),
        "waiting_count": len(waiting),
        "waiting_machine_count": len({item["client_id"] for item in waiting}),
        "waiting": waiting[:20],
        "waiting_groups": waiting_groups[:20],
    })


def watch_tunnel(process: subprocess.Popen) -> None:
    global tunnel_url
    pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
    if process.stdout is None:
        return
    for line in process.stdout:
        match = pattern.search(line)
        if match:
            tunnel_url = match.group(0)
            SHARE_URL_FILE.write_text(tunnel_url, encoding="utf-8")
    if process.poll() is not None:
        tunnel_url = ""
        SHARE_URL_FILE.unlink(missing_ok=True)


@app.post("/api/share/start")
def start_share():
    global tunnel_process, tunnel_url
    blocked = local_only()
    if blocked:
        return blocked
    with tunnel_lock:
        if tunnel_process and tunnel_process.poll() is None:
            return jsonify({"ok": True, "starting": not bool(tunnel_url), "url": tunnel_url})
        bundled_executable = APP_DIR / "bin" / "cloudflared.exe"
        executable = str(bundled_executable) if bundled_executable.exists() else shutil.which("cloudflared")
        if not executable:
            return jsonify({"ok": False, "error": "ยังไม่พบระบบสร้างลิงก์แชร์"}), 503
        tunnel_url = ""
        SHARE_URL_FILE.unlink(missing_ok=True)
        tunnel_process = subprocess.Popen(
            [executable, "tunnel", "--url", "http://127.0.0.1:8765", "--no-autoupdate"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=0x08000000,
        )
        threading.Thread(target=watch_tunnel, args=(tunnel_process,), daemon=True).start()
    return jsonify({"ok": True, "starting": True, "url": ""})


@app.get("/api/share/status")
def share_status():
    blocked = local_only()
    if blocked:
        return blocked
    running = bool(tunnel_process and tunnel_process.poll() is None)
    return jsonify({"ok": True, "running": running, "url": tunnel_url})


@app.post("/api/share/stop")
def stop_share():
    global tunnel_process, tunnel_url
    blocked = local_only()
    if blocked:
        return blocked
    with tunnel_lock:
        if tunnel_process and tunnel_process.poll() is None:
            tunnel_process.terminate()
        tunnel_process = None
        tunnel_url = ""
        SHARE_URL_FILE.unlink(missing_ok=True)
    return jsonify({"ok": True})


@app.post("/api/drive-folder/check")
def check_drive_folder():
    payload = request.get_json(silent=True) or {}
    try:
        folder_id, resource_key = parse_drive_folder_url(payload.get("url", ""))
        images = list_drive_images(folder_id, resource_key)
    except (ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        return jsonify({"ok": False, "error": f"เปิดโฟลเดอร์ไม่ได้: {exc}"}), 400
    return jsonify({
        "ok": True,
        "folder_id": folder_id,
        "count": len(images),
        "total_bytes": sum(int(item.get("Size") or 0) for item in images),
        "files": [{"name": item["Name"], "size": int(item.get("Size") or 0)} for item in images[:100]],
    })


@app.post("/api/drive-folder/import")
def import_drive_folder():
    payload = request.get_json(silent=True) or {}
    client_id = "home-computer" if not is_remote_request() else clean_client_id(payload.get("client_id", ""))
    owner_profile = ensure_client(client_id)
    try:
        folder_id, resource_key = parse_drive_folder_url(payload.get("url", ""))
        images = list_drive_images(folder_id, resource_key)
        if not images:
            return jsonify({"ok": False, "error": "ไม่พบไฟล์รูปในโฟลเดอร์ชั้นแรก"}), 400
        if len(images) > 100:
            return jsonify({"ok": False, "error": "หนึ่งโฟลเดอร์รองรับสูงสุด 100 รูป"}), 400
        with queue_lock:
            available = job_queue.maxsize - job_queue.qsize()
        if len(images) > available:
            return jsonify({"ok": False, "error": f"คิวเหลือที่ว่าง {available} รูป กรุณารอแล้วลองใหม่"}), 503

        result_folder = f"ลบพื้นหลัง_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}"
        remote = rclone_remote(folder_id, resource_key)
        run_rclone(["mkdir", remote + result_folder])
        listed = json.loads(run_rclone(["lsjson", remote, "--dirs-only", "--max-depth", "1"]).stdout or "[]")
        created = next((item for item in listed if item.get("IsDir") and item.get("Name") == result_folder), None)
        if not created or not created.get("ID"):
            raise RuntimeError("สร้างโฟลเดอร์ผลลัพธ์แล้ว แต่ยังอ่านลิงก์กลับไม่ได้")
        result_url = f"https://drive.google.com/drive/folders/{created['ID']}"
    except (ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        message = str(exc)
        if "permission" in message.lower() or "403" in message:
            message = "บัญชี Donut ไม่มีสิทธิ์ Editor ในโฟลเดอร์นี้"
        return jsonify({"ok": False, "error": f"เริ่มงานจาก Drive ไม่ได้: {message}"}), 400

    jobs = []
    for item in images:
        job_id = uuid.uuid4().hex
        folder = JOB_DIR / job_id
        folder.mkdir(parents=True)
        suffix = Path(item["Name"]).suffix.lower()
        source_path = folder / f"source{suffix}"
        output_name = f"{safe_image_stem(item['Name'])}_transparent.png"
        output_path = folder / output_name
        preview_path = folder / "preview.jpg"
        job = {
            "job_id": job_id,
            "folder": str(folder),
            "source_path": str(source_path),
            "output_path": str(output_path),
            "preview_path": str(preview_path),
            "original_name": item["Name"],
            "output_name": output_name,
            "save_home": bool(payload.get("save_home", False)),
            "send_drive": False,
            "send_email": False,
            "recipient_email": "",
            "drive_batch": "",
            "client_id": client_id,
            "owner_display_name": owner_profile["display_name"],
            "owner_number": owner_profile["number"],
            "remote_source": {
                "folder_id": folder_id,
                "resource_key": resource_key,
                "name": item["Name"],
            },
            "source_drive_return": {
                "folder_id": folder_id,
                "resource_key": resource_key,
                "result_folder": result_folder,
                "result_url": result_url,
            },
        }
        write_job_status(folder, {"state": "queued", "stage": "waiting", "job_id": job_id})
        add_job_to_catalog(job)
        with queue_lock:
            jobs_by_id[job_id] = job
            pending_job_ids.append(job_id)
            ahead = (1 if current_job_id else 0) + len(pending_job_ids) - 1
        job_queue.put(job)
        jobs.append({
            "job_id": job_id,
            "original_name": item["Name"],
            "queue_ahead": ahead,
            "status_url": f"/api/jobs/{job_id}/status",
        })

    return jsonify({
        "ok": True,
        "accepted": True,
        "jobs": jobs,
        "result_folder": result_folder,
        "result_drive_url": result_url,
    }), 202


@app.post("/api/process")
def process_image():
    if job_queue.full():
        return jsonify({"ok": False, "error": "คิวเต็มชั่วคราว กรุณาลองใหม่ภายหลัง"}), 503
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"ok": False, "error": "กรุณาเลือกไฟล์รูปภาพ"}), 400
    suffix = Path(upload.filename).suffix.lower()
    if suffix not in ALLOWED:
        return jsonify({"ok": False, "error": "รองรับไฟล์ JPG, PNG, WebP, BMP และ TIFF"}), 400

    job_id = uuid.uuid4().hex
    folder = JOB_DIR / job_id
    folder.mkdir(parents=True)
    safe_stem = safe_image_stem(upload.filename)
    source_path = folder / f"source{suffix}"
    output_name = f"{safe_stem}_transparent.png"
    output_path = folder / output_name
    preview_path = folder / "preview.jpg"
    upload.save(source_path)
    save_home = request.form.get("save_home", "false").lower() == "true"
    send_drive = request.form.get("send_drive", "false").lower() == "true"
    send_email = request.form.get("send_email", "false").lower() == "true"
    recipient_email = request.form.get("recipient_email", "").strip()
    drive_batch = request.form.get("drive_batch", "").strip()
    client_id = "home-computer" if not is_remote_request() else clean_client_id(request.form.get("client_id", ""))
    owner_profile = ensure_client(client_id)
    if not re.fullmatch(r"[0-9_-]{10,40}", drive_batch):
        drive_batch = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    job = {
        "job_id": job_id,
        "folder": str(folder),
        "source_path": str(source_path),
        "output_path": str(output_path),
        "preview_path": str(preview_path),
        "original_name": upload.filename,
        "output_name": output_name,
        "save_home": save_home,
        "send_drive": send_drive,
        "send_email": send_email,
        "recipient_email": recipient_email,
        "drive_batch": drive_batch,
        "client_id": client_id,
        "owner_display_name": owner_profile["display_name"],
        "owner_number": owner_profile["number"],
    }
    write_job_status(folder, {"state": "queued", "stage": "waiting", "job_id": job_id})
    add_job_to_catalog(job)
    with queue_lock:
        jobs_by_id[job_id] = job
        pending_job_ids.append(job_id)
        ahead = (1 if current_job_id else 0) + len(pending_job_ids) - 1
    job_queue.put(job)
    return jsonify({
        "ok": True,
        "accepted": True,
        "job_id": job_id,
        "queue_ahead": ahead,
        "status_url": f"/api/jobs/{job_id}/status",
    }), 202


def replace_file_with_retry(temporary: Path, destination: Path) -> None:
    for attempt in range(12):
        try:
            temporary.replace(destination)
            return
        except PermissionError:
            if attempt == 11:
                raise
            time.sleep(0.04 * (attempt + 1))


def write_job_status(folder: Path, data: dict) -> None:
    path = folder / "status.json"
    temporary = folder / f"status.{threading.get_ident()}.tmp"
    with status_write_lock:
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        try:
            replace_file_with_retry(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def recover_finished_outputs() -> int:
    recovered = 0
    with job_catalog_lock:
        manifests = list(job_catalog.values())
    for manifest in manifests:
        folder = JOB_DIR / manifest["job_id"]
        status_path = folder / "status.json"
        result_path = folder / "result.json"
        output_name = f"{safe_image_stem(manifest.get('original_name', 'image'))}_transparent.png"
        output_path = folder / output_name
        if result_path.exists() or not status_path.exists() or not output_path.exists():
            continue
        try:
            status = json.loads(status_path.read_text(encoding="utf-8"))
            error = str(status.get("error", ""))
            if status.get("state") != "error" or "Access is denied" not in error or "status.tmp" not in error:
                continue
            with Image.open(output_path) as image:
                image.load()
                width, height = image.size
            make_preview(output_path, folder / "preview.jpg")
            metadata = {
                "job_id": manifest["job_id"],
                "original_name": manifest.get("original_name", output_name),
                "output_name": output_name,
                "seconds": 0,
                "width": width,
                "height": height,
                "tiles": 0,
                "removed_islands": 0,
                "recovered": True,
                "delivery": {
                    "home": {"requested": False, "ok": False},
                    "drive": {"requested": False, "ok": False},
                    "email": {"requested": False, "ok": False, "recipient": ""},
                    "source_drive": {"requested": False, "ok": False},
                },
            }
            result_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
            write_job_status(folder, {"state": "completed", "stage": "ready", "job_id": manifest["job_id"]})
            recovered += 1
        except (OSError, ValueError):
            continue
    return recovered


def finish_cancelled_job(folder: Path, job_id: str) -> bool:
    with queue_lock:
        if job_id not in cancelled_job_ids:
            return False
        cancelled_job_ids.remove(job_id)
    for path in folder.iterdir():
        if path.is_file() and path.name not in {"status.json", "status.tmp"}:
            path.unlink(missing_ok=True)
    write_job_status(folder, {"state": "cancelled", "stage": "cancelled", "job_id": job_id})
    return True


def run_job(job: dict) -> None:
    folder = Path(job["folder"])
    source_path = Path(job["source_path"])
    output_path = Path(job["output_path"])
    preview_path = Path(job["preview_path"])
    started = time.perf_counter()
    try:
        if finish_cancelled_job(folder, job["job_id"]):
            return
        remote_source = job.get("remote_source")
        if remote_source:
            write_job_status(folder, {"state": "processing", "stage": "downloading_drive", "job_id": job["job_id"]})
            source_remote = rclone_remote(remote_source["folder_id"], remote_source.get("resource_key", ""))
            run_rclone(["copyto", source_remote + remote_source["name"], str(source_path)], timeout=900)
            if finish_cancelled_job(folder, job["job_id"]):
                return
        write_job_status(folder, {"state": "processing", "stage": "removing_background", "job_id": job["job_id"]})
        report = remover.process(source_path, output_path)
        if finish_cancelled_job(folder, job["job_id"]):
            return
        write_job_status(folder, {"state": "processing", "stage": "creating_preview", "job_id": job["job_id"]})
        make_preview(output_path, preview_path)
        if finish_cancelled_job(folder, job["job_id"]):
            return
    except Exception as exc:
        write_job_status(folder, {
            "state": "error",
            "stage": "failed",
            "job_id": job["job_id"],
            "error": f"ประมวลผลไม่สำเร็จ: {exc}",
        })
        return

    metadata = {
        "job_id": job["job_id"],
        "original_name": job["original_name"],
        "output_name": job["output_name"],
        "seconds": round(time.perf_counter() - started, 1),
        "width": report.width,
        "height": report.height,
        "tiles": report.tiles,
        "removed_islands": report.removed_islands,
    }
    delivery = {
        "home": {"requested": job["save_home"], "ok": False},
        "drive": {"requested": job["send_drive"], "ok": False, "reason": "not_connected"},
        "email": {
            "requested": job["send_email"],
            "ok": False,
            "reason": "not_connected",
            "recipient": job["recipient_email"] if job["send_email"] else "",
        },
        "source_drive": {"requested": bool(job.get("source_drive_return")), "ok": False},
    }
    if job["save_home"]:
        write_job_status(folder, {"state": "processing", "stage": "saving_home", "job_id": job["job_id"]})
        dated_folder = HOME_DELIVERY_DIR / datetime.now().strftime("%Y-%m-%d")
        dated_folder.mkdir(parents=True, exist_ok=True)
        delivered_name = f"{datetime.now().strftime('%H-%M-%S')}_{job['job_id'][:6]}_{job['output_name']}"
        delivered_path = dated_folder / delivered_name
        shutil.copy2(output_path, delivered_path)
        delivery["home"] = {
            "requested": True,
            "ok": True,
            "folder": dated_folder.name,
            "filename": delivered_name,
        }
    if job["send_drive"]:
        write_job_status(folder, {"state": "processing", "stage": "uploading_drive", "job_id": job["job_id"]})
        drive_root = find_drive_delivery_root()
        if drive_root:
            drive_folder = drive_root / job["drive_batch"]
            drive_folder.mkdir(parents=True, exist_ok=True)
            drive_path = drive_folder / job["output_name"]
            shutil.copy2(output_path, drive_path)
            delivery["drive"] = {
                "requested": True,
                "ok": True,
                "folder": job["drive_batch"],
                "filename": job["output_name"],
            }
        else:
            delivery["drive"] = {
                "requested": True,
                "ok": False,
                "reason": "drive_folder_not_found",
            }
    source_drive_return = job.get("source_drive_return")
    if source_drive_return:
        write_job_status(folder, {"state": "processing", "stage": "returning_drive", "job_id": job["job_id"]})
        try:
            return_remote = rclone_remote(
                source_drive_return["folder_id"], source_drive_return.get("resource_key", "")
            )
            destination = f"{return_remote}{source_drive_return['result_folder']}/{job['output_name']}"
            run_rclone(["copyto", str(output_path), destination], timeout=900)
            delivery["source_drive"] = {
                "requested": True,
                "ok": True,
                "folder": source_drive_return["result_folder"],
                "url": source_drive_return["result_url"],
            }
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            delivery["source_drive"] = {
                "requested": True,
                "ok": False,
                "reason": str(exc),
                "folder": source_drive_return["result_folder"],
                "url": source_drive_return["result_url"],
            }
    metadata["delivery"] = delivery
    (folder / "result.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
    write_job_status(folder, {"state": "completed", "stage": "ready", "job_id": job["job_id"]})


def job_worker() -> None:
    global current_job_id
    while True:
        job = job_queue.get()
        skip_job = False
        with queue_lock:
            if job["job_id"] in cancelled_job_ids:
                cancelled_job_ids.remove(job["job_id"])
                skip_job = True
            else:
                if job["job_id"] in pending_job_ids:
                    pending_job_ids.remove(job["job_id"])
                current_job_id = job["job_id"]
        if skip_job:
            for path in Path(job["folder"]).iterdir():
                if path.is_file() and path.name not in {"status.json", "status.tmp"}:
                    path.unlink(missing_ok=True)
            with queue_lock:
                jobs_by_id.pop(job["job_id"], None)
            job_queue.task_done()
            continue
        try:
            run_job(job)
        finally:
            with queue_lock:
                current_job_id = None
                jobs_by_id.pop(job["job_id"], None)
            job_queue.task_done()


recover_finished_outputs()
threading.Thread(target=job_worker, daemon=True).start()


@app.get("/api/jobs/<job_id>/status")
def job_status(job_id: str):
    if not job_id.isalnum():
        return jsonify({"ok": False, "error": "ไม่พบงาน"}), 404
    folder = JOB_DIR / job_id
    status_path = folder / "status.json"
    if not status_path.exists():
        return jsonify({"ok": False, "error": "ไม่พบงาน"}), 404
    status = json.loads(status_path.read_text(encoding="utf-8"))
    response = {"ok": True, **status}
    if status.get("state") == "queued":
        with queue_lock:
            try:
                position = pending_job_ids.index(job_id)
                response["queue_ahead"] = (1 if current_job_id else 0) + position
            except ValueError:
                response["queue_ahead"] = 0
    elif status.get("state") == "completed":
        metadata = json.loads((folder / "result.json").read_text(encoding="utf-8"))
        response.update(metadata)
        response["preview_url"] = f"/files/{job_id}/preview.jpg"
        response["download_url"] = f"/files/{job_id}/{metadata['output_name']}"
        source_files = [path for path in folder.glob("source.*") if path.is_file()]
        if source_files:
            response["source_url"] = f"/files/{job_id}/{source_files[0].name}"
    return jsonify(response)


@app.post("/api/jobs/<job_id>/manual-edit")
def save_manual_edit(job_id: str):
    if not job_id.isalnum():
        return jsonify({"ok": False, "error": "ไม่พบงาน"}), 404
    folder = JOB_DIR / job_id
    status_path = folder / "status.json"
    result_path = folder / "result.json"
    if not status_path.exists() or not result_path.exists():
        return jsonify({"ok": False, "error": "ยังไม่มีไฟล์ผลลัพธ์ให้แก้ไข"}), 404
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
        metadata = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return jsonify({"ok": False, "error": "อ่านข้อมูลผลลัพธ์ไม่ได้"}), 500
    if status.get("state") != "completed":
        return jsonify({"ok": False, "error": "แก้ไขได้เมื่อรูปทำเสร็จแล้ว"}), 409
    uploaded = request.files.get("file")
    if not uploaded:
        return jsonify({"ok": False, "error": "ไม่พบภาพที่แก้ไข"}), 400
    output_name = metadata.get("output_name", "")
    output_path = folder / output_name
    if not output_name or not output_path.exists():
        return jsonify({"ok": False, "error": "ไม่พบ PNG ผลลัพธ์"}), 404

    edited_temp = folder / f"manual-edit-{uuid.uuid4().hex}.tmp.png"
    preview_temp = folder / f"manual-preview-{uuid.uuid4().hex}.tmp.jpg"
    result_temp = folder / f"manual-result-{uuid.uuid4().hex}.tmp.json"
    try:
        with Image.open(uploaded.stream) as edited:
            edited.load()
            expected_size = (int(metadata.get("width", 0)), int(metadata.get("height", 0)))
            if edited.size != expected_size:
                return jsonify({"ok": False, "error": "ขนาดภาพที่แก้ไขไม่ตรงกับต้นฉบับ"}), 400
            edited.convert("RGBA").save(edited_temp, format="PNG", optimize=False)
        with job_edit_lock:
            backup_path = folder / "result_before_manual_edit.png"
            if not backup_path.exists():
                shutil.copy2(output_path, backup_path)
            replace_file_with_retry(edited_temp, output_path)
            make_preview(output_path, preview_temp)
            replace_file_with_retry(preview_temp, folder / "preview.jpg")
            metadata["manually_edited"] = True
            metadata["manual_edit_time"] = datetime.now().isoformat()
            metadata["manual_backup_available"] = True
            result_temp.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
            replace_file_with_retry(result_temp, result_path)
        return jsonify({
            "ok": True,
            "job_id": job_id,
            "preview_url": f"/files/{job_id}/preview.jpg",
            "download_url": f"/files/{job_id}/{output_name}",
            "output_name": output_name,
            "manually_edited": True,
        })
    except (OSError, ValueError) as exc:
        return jsonify({"ok": False, "error": f"บันทึกภาพที่แก้ไขไม่สำเร็จ: {exc}"}), 500
    finally:
        edited_temp.unlink(missing_ok=True)
        preview_temp.unlink(missing_ok=True)
        result_temp.unlink(missing_ok=True)


@app.get("/api/jobs/shared")
def shared_jobs():
    viewer_id = "home-computer" if not is_remote_request() else clean_client_id(request.args.get("client_id", ""))
    with job_catalog_lock:
        manifests = sorted(job_catalog.values(), key=lambda item: item.get("created_at", ""), reverse=True)[:100]
    with queue_lock:
        active_id = current_job_id
        waiting_ids = list(pending_job_ids)
    waiting_positions = {job_id: index for index, job_id in enumerate(waiting_ids, start=1)}
    items = []
    for manifest in manifests:
        job_id = manifest["job_id"]
        folder = JOB_DIR / job_id
        status_path = folder / "status.json"
        if not status_path.exists():
            continue
        try:
            status = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        item = {
            **manifest,
            "state": status.get("state", "queued"),
            "stage": status.get("stage", "waiting"),
            "is_mine": bool(viewer_id and viewer_id == manifest.get("client_id")),
            "status_url": f"/api/jobs/{job_id}/status",
            "cancel_url": f"/api/jobs/{job_id}/cancel",
            "queue_position": waiting_positions.get(job_id),
            "queue_ahead": (
                (1 if active_id else 0) + waiting_positions[job_id] - 1
                if job_id in waiting_positions else 0
            ),
        }
        source_files = [path for path in folder.glob("source.*") if path.is_file()]
        if source_files:
            item["source_url"] = f"/files/{job_id}/{source_files[0].name}"
        if status.get("state") == "completed":
            result_path = folder / "result.json"
            if result_path.exists():
                try:
                    result = json.loads(result_path.read_text(encoding="utf-8"))
                    item["preview_url"] = f"/files/{job_id}/preview.jpg"
                    item["download_url"] = f"/files/{job_id}/{result['output_name']}"
                except (OSError, ValueError, KeyError):
                    pass
        items.append(item)
    return jsonify({"ok": True, "jobs": items})


def remove_completed_job(job_id: str, requester_id: str, home_request: bool) -> tuple[bool, str]:
    with job_catalog_lock:
        manifest = job_catalog.get(job_id)
    if not manifest:
        return False, "ไม่พบงานบนหน้าเว็บ"
    folder = JOB_DIR / job_id
    status_path = folder / "status.json"
    if not status_path.exists():
        return False, "ไม่พบสถานะงาน"
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False, "อ่านสถานะงานไม่ได้"
    if status.get("state") != "completed":
        return False, "ลบออกจากเว็บได้เมื่อรูปทำเสร็จแล้ว"
    shutil.rmtree(folder, ignore_errors=False)
    with job_catalog_lock:
        job_catalog.pop(job_id, None)
    return True, ""


@app.post("/api/jobs/<job_id>/delete")
def delete_completed_job(job_id: str):
    if not job_id.isalnum():
        return jsonify({"ok": False, "error": "ไม่พบงาน"}), 404
    payload = request.get_json(silent=True) or {}
    home_request = not is_remote_request()
    requester_id = "home-computer" if home_request else clean_client_id(payload.get("client_id", ""))
    removed, error = remove_completed_job(job_id, requester_id, home_request)
    if not removed:
        return jsonify({"ok": False, "error": error}), 403
    return jsonify({"ok": True, "deleted": True, "job_id": job_id})


@app.post("/api/jobs/clear-completed")
def clear_completed_jobs():
    payload = request.get_json(silent=True) or {}
    home_request = not is_remote_request()
    requester_id = "home-computer" if home_request else clean_client_id(payload.get("client_id", ""))
    with job_catalog_lock:
        candidate_ids = list(job_catalog)
    deleted = 0
    for job_id in candidate_ids:
        removed, _ = remove_completed_job(job_id, requester_id, home_request)
        if removed:
            deleted += 1
    return jsonify({"ok": True, "deleted_count": deleted})


@app.post("/api/jobs/<job_id>/cancel")
def cancel_job(job_id: str):
    if not job_id.isalnum():
        return jsonify({"ok": False, "error": "ไม่พบงาน"}), 404
    folder = JOB_DIR / job_id
    status_path = folder / "status.json"
    if not status_path.exists():
        return jsonify({"ok": False, "error": "ไม่พบงาน"}), 404
    payload = request.get_json(silent=True) or {}
    requester_id = "home-computer" if not is_remote_request() else clean_client_id(payload.get("client_id", ""))
    with job_catalog_lock:
        manifest = job_catalog.get(job_id, {})
    if is_remote_request() and (not requester_id or requester_id != manifest.get("client_id")):
        return jsonify({"ok": False, "error": "ยกเลิกได้เฉพาะงานของเครื่องคุณ"}), 403
    status = json.loads(status_path.read_text(encoding="utf-8"))
    if status.get("state") == "cancelled":
        return jsonify({"ok": True, "cancelled": True, "job_id": job_id})
    if status.get("state") in {"completed", "error"}:
        return jsonify({"ok": False, "error": "งานนี้จบแล้ว จึงยกเลิกคิวไม่ได้"}), 409

    cancelling_active = False
    with queue_lock:
        if current_job_id == job_id:
            if status.get("stage") in {"saving_home", "uploading_drive", "returning_drive", "ready"}:
                return jsonify({"ok": False, "error": "รูปนี้กำลังส่งผลลัพธ์แล้ว จึงยกเลิกไม่ทัน"}), 409
            cancelled_job_ids.add(job_id)
            cancelling_active = True
        elif job_id not in pending_job_ids:
            return jsonify({"ok": False, "error": "รูปนี้กำลังเริ่มทำ จึงยกเลิกไม่ทัน"}), 409
        else:
            pending_job_ids.remove(job_id)
            cancelled_job_ids.add(job_id)

    if cancelling_active:
        write_job_status(folder, {
            "state": "processing",
            "stage": "cancelling",
            "job_id": job_id,
        })
        return jsonify({"ok": True, "cancelling": True, "job_id": job_id})

    write_job_status(folder, {
        "state": "cancelled",
        "stage": "cancelled",
        "job_id": job_id,
    })
    return jsonify({"ok": True, "cancelled": True, "job_id": job_id})


@app.get("/files/<job_id>/<path:filename>")
def job_file(job_id: str, filename: str):
    if not job_id.isalnum():
        return "Not found", 404
    folder = JOB_DIR / job_id
    allowed = filename == "preview.jpg" or (
        filename.startswith("source.") and Path(filename).suffix.lower() in ALLOWED
    )
    result_path = folder / "result.json"
    if result_path.exists():
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
            allowed = allowed or filename == result.get("output_name")
        except (OSError, ValueError):
            pass
    if not allowed:
        return "Not found", 404
    return send_from_directory(folder, filename, as_attachment=filename.endswith(".png"))


@app.post("/api/zip")
def download_zip():
    job_ids = request.get_json(silent=True) or {}
    job_ids = job_ids.get("job_ids", [])
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", zipfile.ZIP_DEFLATED) as archive:
        for job_id in job_ids:
            if not isinstance(job_id, str) or not job_id.isalnum():
                continue
            folder = JOB_DIR / job_id
            info_path = folder / "result.json"
            if not info_path.exists():
                continue
            info = json.loads(info_path.read_text(encoding="utf-8"))
            output = folder / info["output_name"]
            if output.exists():
                archive.write(output, arcname=info["output_name"])
    memory.seek(0)
    return send_file(memory, mimetype="application/zip", as_attachment=True, download_name="transparent-images.zip")


@app.post("/api/open-folder")
def open_folder():
    blocked = local_only()
    if blocked:
        return blocked
    subprocess.Popen(["explorer.exe", str(HOME_DELIVERY_DIR)], creationflags=0x08000000)
    return jsonify({"ok": True})


@app.post("/api/shutdown")
def shutdown():
    blocked = local_only()
    if blocked:
        return blocked
    def stop():
        time.sleep(0.4)
        if tunnel_process and tunnel_process.poll() is None:
            tunnel_process.terminate()
        os._exit(0)
    threading.Thread(target=stop, daemon=True).start()
    return jsonify({"ok": True})


def open_browser():
    time.sleep(1.2)
    webbrowser.open("http://127.0.0.1:8765")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8765))
    host = os.environ.get("HOST", "127.0.0.1" if port == 8765 else "0.0.0.0")
    if host == "127.0.0.1" and port == 8765:
        threading.Thread(target=open_browser, daemon=True).start()
    app.run(host=host, port=port, threaded=True, use_reloader=False)

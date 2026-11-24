from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import logging
from pathlib import Path
import re
from threading import Lock
import urllib.parse
import webbrowser
import zipfile

from awc_core import get_base_id, get_cached_awc, process_awc_bytes

PORT = 8765
BASE_DIR = Path(__file__).resolve().parent
WORK_DIR = BASE_DIR / "output"
WORK_DIR.mkdir(parents=True, exist_ok=True)
NAME_INDEX_LOCK = Lock()


def safe_folder_label(value):
    label = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value)).strip(" .")
    return label[:120]


def _read_awc_name_index(index_file):
    if not index_file.is_file():
        return {}
    names = json.loads(index_file.read_text(encoding="utf-8"))
    if not isinstance(names, dict):
        raise ValueError(f"Invalid AWC name index format in {index_file}")
    return {
        str(key): value
        for key, value in names.items()
        if isinstance(value, str)
    }


def _write_awc_name_index(index_file, names):
    temp_file = index_file.with_name(f"{index_file.name}.tmp")
    temp_file.write_text(json.dumps(names, indent=2), encoding="utf-8")
    temp_file.replace(index_file)


def save_awc_name(base_id, display_name):
    index_file = WORK_DIR / "awc_names.json"
    with NAME_INDEX_LOCK:
        names = _read_awc_name_index(index_file)
        names[str(base_id)] = display_name
        _write_awc_name_index(index_file, names)


def seed_awc_name_index():
    index_file = WORK_DIR / "awc_names.json"
    with NAME_INDEX_LOCK:
        names = _read_awc_name_index(index_file)
        changed = False
        for source_dir in WORK_DIR.iterdir():
            if not source_dir.is_dir() or source_dir.name.startswith("TRACK_"):
                continue
            labels_file = source_dir / "labels.json"
            if not labels_file.is_file():
                continue
            try:
                metadata = json.loads(labels_file.read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                logging.warning("Unable to read AWC metadata %s: %s", labels_file, error)
                continue
            if not isinstance(metadata, dict):
                continue
            display_name = metadata.get("display_name")
            if not isinstance(display_name, str) or not display_name.strip():
                continue
            base_id = get_base_id(source_dir.name)
            if base_id not in names:
                names[base_id] = display_name.strip()
                changed = True
        if changed:
            _write_awc_name_index(index_file, names)


class AWCHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/":
            body = (BASE_DIR / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif path == "/app.js":
            body = (BASE_DIR / "app.js").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif path == "/favicon.svg":
            body = (BASE_DIR / "favicon.svg").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif path == "/logo.svg":
            body = (BASE_DIR / "logo.svg").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif path == "/check":
            qs = dict(urllib.parse.parse_qsl(parsed.query))
            fname = qs.get("name", "unknown.awc")
            fmt = qs.get("fmt", "opus")
            cached = get_cached_awc(fname, WORK_DIR, fmt)
            body = json.dumps(cached or {"cached": False}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif path.startswith("/file/"):
            parts = path[len("/file/"):].split("/", 1)
            if len(parts) == 2:
                raw_folder, raw_fname = parts
                folder = urllib.parse.unquote(raw_folder)
                fname = urllib.parse.unquote(raw_fname)
                fpath = (WORK_DIR / folder / fname).resolve()
                if WORK_DIR.resolve() in fpath.parents and fpath.is_file():
                    data = fpath.read_bytes()
                    total = len(data)
                    if fname.endswith(".wav"):
                        ctype = "audio/wav"
                    elif fname.endswith(".flac"):
                        ctype = "audio/flac"
                    else:
                        ctype = "audio/ogg; codecs=opus"

                    range_hdr = self.headers.get("Range")
                    if range_hdr and range_hdr.startswith("bytes="):
                        start_s, _, end_s = range_hdr[len("bytes="):].partition("-")
                        start = int(start_s) if start_s else 0
                        end = int(end_s) if end_s else total - 1
                        end = min(end, total - 1)
                        chunk = data[start : end + 1]
                        self.send_response(206)
                        self.send_header("Content-Type", ctype)
                        self.send_header("Accept-Ranges", "bytes")
                        self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                        self.send_header("Content-Length", str(len(chunk)))
                        self.end_headers()
                        self.wfile.write(chunk)
                    else:
                        self.send_response(200)
                        self.send_header("Content-Type", ctype)
                        self.send_header("Accept-Ranges", "bytes")
                        self.send_header("Content-Length", str(total))
                        self.end_headers()
                        self.wfile.write(data)
                    return
            self.send_error(404)

        elif path.startswith("/zip/") or path == "/zip_all":
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
                if path == "/zip_all":
                    zip_name = "gta6_awc_extracted.zip"
                    for f in sorted(WORK_DIR.rglob("*")):
                        if f.is_file():
                            zf.write(f, f.relative_to(WORK_DIR))
                else:
                    folder = urllib.parse.unquote(path[len("/zip/"):])
                    zip_name = f"{folder}.zip"
                    target_dir = (WORK_DIR / folder).resolve()
                    if WORK_DIR.resolve() in target_dir.parents and target_dir.is_dir():
                        for f in sorted(target_dir.iterdir()):
                            if f.is_file():
                                zf.write(f, f"{folder}/{f.name}")
            zdata = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="{zip_name}"')
            self.send_header("Content-Length", str(len(zdata)))
            self.end_headers()
            self.wfile.write(zdata)
        else:
            self.send_error(404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/upload":
            qs = dict(urllib.parse.parse_qsl(parsed.query))
            fname = qs.get("name", "unknown.awc")
            fmt = qs.get("fmt", "opus")
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)

            res = process_awc_bytes(fname, raw, WORK_DIR, fmt)
            body = json.dumps(res).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif parsed.path == "/save_labels":
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            folder = Path(payload.get("folder", "")).name
            labels = payload.get("labels", {})
            if not isinstance(labels, dict):
                self.send_error(400, "Invalid track labels")
                return
            src_dir = (WORK_DIR / folder).resolve()
            if WORK_DIR.resolve() not in src_dir.parents or not src_dir.is_dir():
                self.send_error(404)
                return
            clean = {}
            for key, value in labels.items():
                if not isinstance(key, str) or not isinstance(value, dict):
                    self.send_error(400, "Invalid track label record")
                    return
                metadata = {}
                category = value.get("category")
                subgroup = value.get("subgroup")
                if category is not None:
                    if not isinstance(category, str) or not category:
                        self.send_error(400, "Invalid track category")
                        return
                    metadata["category"] = category
                if subgroup is not None:
                    if not isinstance(subgroup, str) or subgroup not in ("A", "B", "C", "D", "E", "F", "G", "H"):
                        self.send_error(400, "Invalid track subgroup")
                        return
                    metadata["subgroup"] = subgroup
                if metadata:
                    clean[Path(key).name] = metadata
            display_name = payload.get("display_name", "")
            if not isinstance(display_name, str):
                self.send_error(400, "Invalid AWC display name")
                return
            metadata = {
                "display_name": display_name,
                "labels": clean,
            }
            (src_dir / "labels.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            save_awc_name(get_base_id(folder), display_name)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        elif parsed.path == "/save_track":
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            folder = Path(payload.get("folder", "")).name
            items = payload.get("items", [])
            src_dir = (WORK_DIR / folder).resolve()
            track_folder = f"TRACK_{folder}"
            if payload.get("include_name"):
                name = safe_folder_label(payload.get("display_name", ""))
                if name:
                    track_folder = f"{track_folder} - {name}"
            dst_dir = (WORK_DIR / track_folder).resolve()
            if WORK_DIR.resolve() not in src_dir.parents or not src_dir.is_dir():
                self.send_error(404)
                return
            dst_dir.mkdir(parents=True, exist_ok=True)
            saved = []
            for item in items:
                s_name = Path(item.get("source_name", "")).name
                t_name = Path(item.get("target_name", "")).name
                src_file = (src_dir / s_name).resolve()
                if src_file.parent == src_dir and src_file.is_file() and t_name:
                    dst_file = (dst_dir / t_name).resolve()
                    if dst_file.parent == dst_dir:
                        dst_file.write_bytes(src_file.read_bytes())
                        saved.append(t_name)

            labels_file = src_dir / "labels.json"
            if labels_file.is_file():
                (dst_dir / "labels.json").write_bytes(labels_file.read_bytes())

            body = json.dumps({"folder": track_folder, "saved": saved}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif parsed.path == "/clear":
            for f in WORK_DIR.rglob("*"):
                if f.is_file():
                    f.unlink()
            for d in sorted(WORK_DIR.rglob("*"), reverse=True):
                if d.is_dir():
                    d.rmdir()
            self.send_response(200)
            self.end_headers()
        else:
            self.send_error(404)


if __name__ == "__main__":
    seed_awc_name_index()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), AWCHandler)
    url = f"http://127.0.0.1:{PORT}"
    print(f"GTA VI AWC Web UI running at {url} (Output: {WORK_DIR})")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
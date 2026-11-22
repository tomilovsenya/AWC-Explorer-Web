from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import urllib.parse
import webbrowser
import zipfile

from awc_core import get_cached_awc, process_awc_bytes

PORT = 8765
BASE_DIR = Path(__file__).resolve().parent
WORK_DIR = BASE_DIR / "output"
WORK_DIR.mkdir(parents=True, exist_ok=True)


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
            src_dir = (WORK_DIR / folder).resolve()
            if WORK_DIR.resolve() not in src_dir.parents or not src_dir.is_dir():
                self.send_error(404)
                return
            clean = {Path(k).name: str(v) for k, v in labels.items() if v}
            (src_dir / "labels.json").write_text(json.dumps(clean, indent=2), encoding="utf-8")
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
            dst_dir = (WORK_DIR / f"TRACK_{folder}").resolve()
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

            body = json.dumps({"folder": f"TRACK_{folder}", "saved": saved}).encode("utf-8")
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
    server = ThreadingHTTPServer(("127.0.0.1", PORT), AWCHandler)
    url = f"http://127.0.0.1:{PORT}"
    print(f"GTA VI AWC Web UI running at {url} (Output: {WORK_DIR})")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
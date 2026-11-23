from concurrent.futures import ProcessPoolExecutor, as_completed
import json
import logging
import os
from pathlib import Path
import re
import struct
import subprocess


def _build_crc_table() -> tuple[int, ...]:
    table = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) if (r & 0x80000000) else (r << 1)
            r &= 0xFFFFFFFF
        table.append(r)
    return tuple(table)


_CRC_TABLE = _build_crc_table()


def ogg_crc(data: bytes) -> int:
    crc = 0
    tbl = _CRC_TABLE
    for b in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ tbl[((crc >> 24) ^ b) & 0xFF]
    return crc


def make_ogg_page(payload: bytes, serial: int, seq: int, granule: int, flags: int = 0) -> bytes:
    rem = len(payload)
    full_segs, last_seg = divmod(rem, 255)
    lacing = b"\xff" * full_segs + bytes((last_seg,))

    hdr_zero = struct.pack("<4sBBqIIIB", b"OggS", 0, flags, granule, serial, seq, 0, len(lacing)) + lacing
    crc = ogg_crc(hdr_zero + payload)
    hdr = struct.pack("<4sBBqIIIB", b"OggS", 0, flags, granule, serial, seq, crc, len(lacing)) + lacing
    return hdr + payload


def opus_packet_samples(pkt: bytes) -> int:
    toc = pkt[0]
    config = toc >> 3
    c = toc & 0x03
    if config < 12:
        samples = (480, 960, 1920, 2880)[config & 0x03]
    elif config < 16:
        samples = (480, 960)[config & 0x01]
    else:
        samples = (120, 240, 480, 960)[config & 0x03]

    if c == 0:
        frames = 1
    elif c in (1, 2):
        frames = 2
    else:
        frames = (pkt[1] & 0x3F) if len(pkt) > 1 else 1
    return samples * frames


def build_ogg_opus(packets: list[bytes], channels: int, sample_rate: int = 48000, serial: int = 1) -> bytes:
    out = bytearray()
    opus_head = struct.pack("<8sBBHIhB", b"OpusHead", 1, channels, 312, sample_rate, 0, 0)
    out += make_ogg_page(opus_head, serial, 0, 0, flags=0x02)

    vendor = b"RAGE-AWC"
    opus_tags = struct.pack("<8sI", b"OpusTags", len(vendor)) + vendor + struct.pack("<I", 0)
    out += make_ogg_page(opus_tags, serial, 1, 0, flags=0x00)

    granule = 0
    for i, pkt in enumerate(packets):
        granule += opus_packet_samples(pkt)
        is_last = (i == len(packets) - 1)
        out += make_ogg_page(pkt, serial, i + 2, granule, flags=(0x04 if is_last else 0x00))
    return bytes(out)


def get_base_id(stem: str) -> str:
    m = re.search(r"audio_sound_(\d+)", stem, re.IGNORECASE)
    if m:
        return m.group(1)
    m_fallback = re.search(r"(\d+)", stem)
    return m_fallback.group(1) if m_fallback else stem


def find_data_chunks(data: bytes, flags: int, sc: int, hdr_sz: int) -> list[tuple[int, int]]:
    chunks = []
    if flags & 0x00200000:
        indices = [struct.unpack_from("<H", data, 16 + i * 2)[0] for i in range(sc)]
        table_start = 16 + sc * 2 + sc * 8 + 4
        if indices and table_start + indices[-1] * 8 > hdr_sz:
            table_start = 16 + sc * 2 + sc * 8
        off = table_start
        while off + 8 <= hdr_sz:
            val, = struct.unpack_from("<Q", data, off)
            tag = (val >> 56) & 0xFF
            sz = (val >> 28) & 0x0FFFFFFF
            coff = val & 0x0FFFFFFF
            if tag == 0x55 and sz > 0 and hdr_sz <= coff and coff + sz <= len(data):
                chunks.append((coff, sz))
            off += 8
    else:
        off = 16 + sc * 4
        while off + 8 <= hdr_sz:
            val, = struct.unpack_from("<Q", data, off)
            tag = (val >> 56) & 0xFF
            sz = (val >> 28) & 0x0FFFFFFF
            coff = val & 0x0FFFFFFF
            if tag == 0 and coff == 0:
                break
            if tag == 0x55 and sz > 0 and coff >= 0x20 and coff + sz <= len(data):
                chunks.append((coff, sz))
            off += 8

    if not chunks:
        for off in range(16, hdr_sz - 8, 2):
            val, = struct.unpack_from("<Q", data, off)
            tag = (val >> 56) & 0xFF
            sz = (val >> 28) & 0x0FFFFFFF
            coff = val & 0x0FFFFFFF
            if tag == 0x55 and sz > 0 and hdr_sz <= coff and coff + sz <= len(data):
                plen, = struct.unpack_from("<H", data, coff)
                if 1 <= plen <= 2046 and coff + 2 + plen <= len(data):
                    chunks.append((coff, sz))
    return chunks


def convert_worker(blob: bytes, out_file_str: str, ext: str, serial: int):
    out_file = Path(out_file_str)
    packets = []
    total_samples = 0
    for blk_start in range(0, len(blob), 2048):
        blk = blob[blk_start : blk_start + 2048]
        p = 0
        while p + 2 <= len(blk):
            plen, = struct.unpack_from("<H", blk, p)
            if plen == 0 or p + 2 + plen > len(blk):
                break
            pkt = blk[p + 2 : p + 2 + plen]
            packets.append(pkt)
            total_samples += opus_packet_samples(pkt)
            p += 2 + plen

    if not packets:
        return None

    channels = 2 if (packets[0][0] & 0x04) else 1
    ogg_bytes = build_ogg_opus(packets, channels, 48000, serial=serial)

    if ext.lower() in ("ogg", "opus"):
        out_file.write_bytes(ogg_bytes)
    else:
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", str(out_file)]
        subprocess.run(cmd, input=ogg_bytes, check=True)

    dur_sec = max(0.0, (total_samples - 312) / 48000.0)
    return {
        "name": out_file.name,
        "folder": out_file.parent.name,
        "channels": channels,
        "duration": round(dur_sec, 2),
        "size": out_file.stat().st_size,
    }


_POOL: ProcessPoolExecutor | None = None


def get_pool() -> ProcessPoolExecutor:
    global _POOL
    if _POOL is None:
        _POOL = ProcessPoolExecutor(max_workers=(os.cpu_count() or 4))
    return _POOL


def _probe_wav(path: Path) -> tuple[int, float]:
    data = path.read_bytes()
    if len(data) >= 44 and data[:4] == b"RIFF":
        ch, sr, byte_rate = struct.unpack_from("<HII", data, 22)
        dur = max(0.0, (len(data) - 44) / byte_rate) if byte_rate else 0.0
        return ch, round(dur, 2)
    return 1, 0.0


def _probe_ogg_opus(path: Path) -> tuple[int, float]:
    data = path.read_bytes()
    channels = 1
    head_pos = data.find(b"OpusHead")
    if head_pos != -1 and head_pos + 10 <= len(data):
        channels = data[head_pos + 9]

    last_oggs = data.rfind(b"OggS")
    dur = 0.0
    if last_oggs != -1 and last_oggs + 14 <= len(data):
        granule, = struct.unpack_from("<q", data, last_oggs + 6)
        if granule > 312:
            dur = round((granule - 312) / 48000.0, 2)
    return channels, dur


def _read_indexed_awc_name(base_id: str, work_dir: Path) -> str | None:
    index_file = work_dir / "awc_names.json"
    if not index_file.is_file():
        return None
    try:
        names = json.loads(index_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        logging.warning("Unable to read AWC name index %s: %s", index_file, error)
        return None
    if not isinstance(names, dict):
        logging.warning("Invalid AWC name index format in %s", index_file)
        return None
    name = names.get(base_id)
    if not isinstance(name, str):
        return None
    return name.strip() or None


def _apply_saved_labels(base_id: str, work_dir: Path, tracks: list[dict], ext: str) -> str | None:
    saved_map: dict[str, str] = {}
    saved_subgroups: dict[str, str] = {}
    display_name = _read_indexed_awc_name(base_id, work_dir)
    track_dirs = [work_dir / f"TRACK_{base_id}"]
    track_dirs.extend(sorted(work_dir.glob(f"TRACK_{base_id} - *")))
    for candidate_dir in (work_dir / base_id, *track_dirs):
        labels_file = candidate_dir / "labels.json"
        if labels_file.is_file():
            try:
                raw = json.loads(labels_file.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    if display_name is None and isinstance(raw.get("display_name"), str):
                        display_name = raw["display_name"].strip() or None
                    labels = raw.get("labels") if isinstance(raw.get("labels"), dict) else raw
                    if not saved_map and labels:
                        saved_map = {str(k): str(v) for k, v in labels.items() if v}
                    subgroups = raw.get("subgroups")
                    if not saved_subgroups and isinstance(subgroups, dict):
                        saved_subgroups = {
                            str(k): v
                            for k, v in subgroups.items()
                            if isinstance(v, str) and v in ("A", "B", "C", "D")
                        }
            except (OSError, ValueError):
                pass

    # Fallback: match already-exported files by (size, duration).
    by_sig: dict[tuple[int, float], list[tuple[str, str | None]]] = {}
    for track_dir in track_dirs:
        if not track_dir.is_dir():
            continue
        pat = re.compile(rf"^{re.escape(base_id)}_([A-Z0-9]+)(?:_([A-D]))?_\d+\.{re.escape(ext)}$", re.I)
        for f in sorted(track_dir.glob(f"{base_id}_*_*.{ext}")):
            m = pat.match(f.name)
            if not m:
                continue
            tag = m.group(1).upper()
            subgroup = m.group(2).upper() if m.group(2) else None
            if ext.lower() == "wav":
                _, dur = _probe_wav(f)
            elif ext.lower() in ("opus", "ogg"):
                _, dur = _probe_ogg_opus(f)
            else:
                dur = 0.0
            by_sig.setdefault((f.stat().st_size, dur), []).append((tag, subgroup))

    for t in tracks:
        tag = saved_map.get(t["name"])
        subgroup = saved_subgroups.get(t["name"])
        if not tag:
            candidates = by_sig.get((t.get("size", 0), t.get("duration", 0.0)))
            if candidates:
                tag, fallback_subgroup = candidates.pop(0)
                if subgroup is None:
                    subgroup = fallback_subgroup
        if tag:
            t["tag"] = tag
        if subgroup:
            t["subgroup"] = subgroup
    return display_name


def process_awc_bytes(filename: str, data: bytes, work_dir: Path, ext: str) -> dict:
    if len(data) < 16 or data[:4] != b"ADAT":
        return {"file": filename, "error": "Not a valid ADAT .awc file", "tracks": []}

    _, flags, sc, hdr_sz = struct.unpack_from("<4sIII", data, 0)
    hdr_sz = min(hdr_sz, len(data))
    chunks = find_data_chunks(data, flags, sc, hdr_sz)
    if not chunks:
        return {"file": filename, "error": "No Opus streams found", "tracks": []}

    base_id = get_base_id(Path(filename).stem)
    out_dir = work_dir / base_id
    out_dir.mkdir(parents=True, exist_ok=True)
    pad = max(2, len(str(len(chunks))))

    pool = get_pool()
    futures = {}
    for idx, (coff, csz) in enumerate(chunks, start=1):
        blob = data[coff : coff + csz]
        out_file = out_dir / f"{base_id}_BIT_{idx:0{pad}d}.{ext}"
        fut = pool.submit(convert_worker, blob, str(out_file), ext, idx)
        futures[fut] = idx

    results = {}
    for fut in as_completed(futures):
        res = fut.result()
        if res:
            results[futures[fut]] = res

    tracks = [results[idx] for idx in sorted(results)]
    display_name = _apply_saved_labels(base_id, work_dir, tracks, ext)
    return {
        "file": filename,
        "display_name": display_name or Path(filename).name,
        "id": base_id,
        "flags": f"0x{flags:08X}",
        "tracks": tracks,
    }


def get_cached_awc(filename: str, work_dir: Path, ext: str) -> dict | None:
    base_id = get_base_id(Path(filename).stem)
    out_dir = work_dir / base_id
    if not out_dir.is_dir():
        return None

    existing = sorted(out_dir.glob(f"{base_id}_BIT_*.{ext}"))
    if not existing:
        return None

    tracks = []
    for f in existing:
        if ext.lower() == "wav":
            ch, dur = _probe_wav(f)
        elif ext.lower() in ("opus", "ogg"):
            ch, dur = _probe_ogg_opus(f)
        else:
            ch, dur = 2, 0.0
        tracks.append({
            "name": f.name,
            "folder": base_id,
            "channels": ch,
            "duration": dur,
            "size": f.stat().st_size,
        })

    display_name = _apply_saved_labels(base_id, work_dir, tracks, ext)
    return {
        "file": filename,
        "display_name": display_name or Path(filename).name,
        "id": base_id,
        "cached": True,
        "tracks": tracks,
    }
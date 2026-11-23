# AWC Explorer

![AWC Explorer](src/logo.svg)

A fast, multi-core `.awc` (Audio Wave Container) extractor and browser-based audio player built for **Project Americas**. Unpacks embedded RAGE Opus audio streams into organized folders with instant waveform previewing, seamless crossfade looping, and one-click `.zip` exports.

---

## Features

* **Multi-Core Extraction:** Uses Python's `ProcessPoolExecutor` and a precomputed CRC-32 lookup table to saturate all CPU cores when unpacking large archives.
* **Zero-Loss Native Remuxing:** Extracts `.opus` and `.ogg` streams directly to disk without re-encoding or spawning external processes; optionally decodes to `.wav` or `.flac` via FFmpeg.
* **Supports Updated Container Layouts:** Automatically handles both standard (`0xFF010001`) and extended (`0xFF210001`) RAGE `ADAT` header tables.
* **Smart Disk Caching:** Automatically detects already-extracted `<ID>` folders inside `./output/` and loads them instantaneously without re-decoding.
* **Full-Window Drag & Drop:** Drop single or multiple `.awc` files anywhere on the browser window at any scroll depth.
* **Interactive Waveform Player:**
  * 60–144 FPS `<canvas>` amplitude waveform seekbar with click-and-drag scrubbing.
  * **Loop X-Fade:** Seamless equal-power 3% crossfade looping powered by the Web Audio API.
  * **Single Playback & Auto-Next:** Automatically pauses overlapping tracks or plays sequentially through an entire soundbank.
  * **Keyboard Shortcuts:** `Space` to Play/Pause, `↑` / `↓` arrows to step between tracks.
* **Editable AWC Names & Track Labels:** Rename each imported AWC in its tracklist; category labels and optional A–D pattern groups persist in `labels.json`. Group letters appear in renamed tracks and sort within each category.
* **Sortable Tracklists & Batch ZIPs:** Sort streams by **Output Path**, **Category**, **Duration**, or **File Size**, save labeled tracks to `TRACK_<ID> - <Name>/`, and download individual `<ID>.zip` archives or all extracted folders at once.

---

## Project Structure

```text
├── awc_core.py      # Binary .awc parser, Ogg Opus muxer, FFmpeg bridge & cache reader
├── awc_web_ui.py    # Local HTTP server with byte-range streaming & ZIP packaging
├── favicon.svg      # Neon AWC browser icon
├── logo.svg         # Horizontal AWC Explorer wordmark
├── index.html       # Web UI layout and styling
├── app.js           # Waveform renderer, crossfade loop engine & UI logic
└── output/          # Extracted tracks, labels, and the awc_names.json ID-to-name index
```

---

## Requirements

* **Python 3.10+** (uses only built-in standard library modules—no `pip install` required)
* **FFmpeg** in your system `PATH` *(only required if converting to `WAV` or `FLAC`; `OPUS` and `OGG` work out of the box)*

---

## Usage

1. Place `awc_core.py`, `awc_web_ui.py`, `index.html`, and `app.js` in the same folder.
2. Start the local server:
   ```bash
   python awc_web_ui.py
   ```

   Alternatively, you can open the .py file with Python.
3. Your browser will open automatically to `http://127.0.0.1:8765`.
4. Select your desired output format (`OPUS`, `WAV`, `OGG`, or `FLAC`) and drag and drop one or more `.awc` files anywhere onto the page.
5. Extracted tracks are saved automatically to:
   ```text
   output/<ID>/<ID>_BIT_01.opus
   ```

---

## Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `Space` | Play / Pause active track |
| `↓` (Down Arrow) | Play next track |
| `↑` (Up Arrow) | Play previous track |

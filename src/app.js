const fileInput = document.getElementById('fileInput');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const zipAllBtn = document.getElementById('zipAllBtn');
const singlePlayEl = document.getElementById('singlePlay');
const autoPlayOnLabelEl = document.getElementById('autoPlayOnLabel');
const overlayEl = document.getElementById('globalDropOverlay');

const playerBar = document.getElementById('playerBar');
const pbTitle = document.getElementById('pbTitle');
const pbSub = document.getElementById('pbSub');
const pbPlayBtn = document.getElementById('pbPlayBtn');
const pbWaveWrap = document.getElementById('pbWaveWrap');
const pbWave = document.getElementById('pbWave');
const waveCtx = pbWave.getContext('2d');
const pbTime = document.getElementById('pbTime');
const autoNextEl = document.getElementById('autoNext');
const loopFadeEl = document.getElementById('loopFade');

const ROLE_TAGS = ['INTRO', 'OUTRO', 'PAD', 'PERC', 'LEAD', 'BASS', 'DRUMS', 'SYNTH', 'OTHER', 'CALM'];

let activeAudio = null;
let isSeeking = false;
let rafId = null;
let dragDepth = 0;
let audioCtx = null;
let currentPeaks = null;
let xfadeState = null;

const waveCache = new Map();
const bufferCache = new Map();

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function recomputeGroupDraftNames(tracks) {
  const counts = new Map();
  tracks.forEach(t => {
    if (!t.tag) {
      t.draftName = t.name;
      return;
    }
    const nextNum = (counts.get(t.tag) || 0) + 1;
    counts.set(t.tag, nextNum);

    const dot = t.name.lastIndexOf('.');
    const ext = dot >= 0 ? t.name.slice(dot) : '';
    const idMatch = t.name.match(/^(\d+)/);
    const prefix = idMatch ? idMatch[1] : (t.folder || 'TRACK');
    t.draftName = `${prefix}_${t.tag}_${nextNum}${ext}`;
  });
}

function persistGroupLabels(folderId, tracks) {
  const labels = {};
  tracks.forEach(t => {
    if (t.tag) labels[t.name] = t.tag;
  });
  fetch('/save_labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: folderId, labels })
  }).catch(() => {});
}

function applyLabelAndAdvance(folderId, tracks, track, tag, rerenderFn) {
  track.tag = tag;
  recomputeGroupDraftNames(tracks);
  persistGroupLabels(folderId, tracks);
  if (autoPlayOnLabelEl?.checked) {
    const list = Array.from(document.querySelectorAll('audio'));
    if (list.length > 0) {
      const idx = activeAudio ? list.indexOf(activeAudio) : -1;
      const next = list.at((idx + 1 + list.length) % list.length);
      if (activeAudio) {
        activeAudio.pause();
        activeAudio.currentTime = 0;
      }
      next.currentTime = 0;
      next.play().catch(() => {});
      activeAudio = next;
    }
  }
  rerenderFn?.(activeAudio);
}

function stopXfadeLoop() {
  if (!xfadeState) return;
  xfadeState.active = false;
  clearTimeout(xfadeState.timer);
  xfadeState.sources.forEach(src => { try { src.stop(); src.disconnect(); } catch (_) {} });
  xfadeState.sources.clear();
  xfadeState = null;
}

function getXfadeCurrentTime() {
  if (!xfadeState || !audioCtx) return 0;
  return Math.max(0, (audioCtx.currentTime - xfadeState.cycleStartCtxTime) % xfadeState.stepDur);
}

function startXfadeLoop(url, offsetSec = 0) {
  stopXfadeLoop();
  const audioBuf = bufferCache.get(url);
  if (!audioBuf || !audioCtx) return false;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (activeAudio && !activeAudio.paused) activeAudio.pause();

  const dur = audioBuf.duration;
  const fadeDur = Math.min(dur * 0.4, Math.max(0.04, Math.min(2.5, dur * 0.03)));
  const stepDur = Math.max(0.05, dur - fadeDur);
  const state = {
    active: true, url, dur, fadeDur, stepDur, timer: null, sources: new Set(),
    cycleStartCtxTime: audioCtx.currentTime - Math.min(offsetSec, stepDur)
  };
  xfadeState = state;
  pbPlayBtn.textContent = '⏸';

  function scheduleIteration(when, startOffset, isFirst) {
    if (!state.active || xfadeState !== state) return;
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuf;
    const gain = audioCtx.createGain();
    const playLen = dur - startOffset;

    if (isFirst && startOffset > 0.01) {
      gain.gain.setValueAtTime(1, when);
    } else {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + fadeDur);
    }
    const fadeOutStart = when + Math.max(0, playLen - fadeDur);
    gain.gain.setValueAtTime(1, fadeOutStart);
    gain.gain.linearRampToValueAtTime(0, when + playLen);

    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start(when, startOffset);
    state.sources.add(src);
    src.onended = () => state.sources.delete(src);

    const nextWhen = when + Math.max(0.02, playLen - fadeDur);
    const delayMs = Math.max(5, (nextWhen - audioCtx.currentTime - 0.08) * 1000);
    state.timer = setTimeout(() => {
      if (!state.active || xfadeState !== state) return;
      state.cycleStartCtxTime = nextWhen;
      scheduleIteration(nextWhen, 0, false);
    }, delayMs);
  }

  scheduleIteration(audioCtx.currentTime, Math.min(offsetSec, stepDur), true);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(updateSeekLoop);
  return true;
}

loopFadeEl.addEventListener('change', () => {
  if (!activeAudio) return;
  const url = activeAudio.getAttribute('src');
  if (loopFadeEl.checked && bufferCache.has(url)) {
    startXfadeLoop(url, activeAudio.currentTime || 0);
  } else if (!loopFadeEl.checked && xfadeState) {
    const cur = getXfadeCurrentTime();
    stopXfadeLoop();
    activeAudio.currentTime = cur;
    activeAudio.play();
  }
});

async function loadWaveform(url) {
  currentPeaks = null;
  drawWaveform(0);
  if (waveCache.has(url)) {
    currentPeaks = waveCache.get(url);
    drawWaveform(activeAudio && activeAudio.duration ? activeAudio.currentTime / activeAudio.duration : 0);
    if (loopFadeEl.checked && bufferCache.has(url) && activeAudio?.getAttribute('src') === url) {
      startXfadeLoop(url, activeAudio.currentTime || 0);
    }
    return;
  }
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch(url);
    const audioBuf = await audioCtx.decodeAudioData(await res.arrayBuffer());
    bufferCache.set(url, audioBuf);

    const chData = audioBuf.getChannelData(0);
    const bars = 260;
    const step = Math.max(1, Math.floor(chData.length / bars));
    const peaks = [];
    let maxPeak = 0.01;
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      const end = Math.min((i + 1) * step, chData.length);
      for (let j = i * step; j < end; j++) {
        const v = Math.abs(chData.at(j));
        if (v > peak) peak = v;
      }
      peaks.push(peak);
      if (peak > maxPeak) maxPeak = peak;
    }
    const normPeaks = peaks.map(p => p / maxPeak);
    waveCache.set(url, normPeaks);

    if (activeAudio?.getAttribute('src') === url) {
      currentPeaks = normPeaks;
      drawWaveform(activeAudio.duration ? activeAudio.currentTime / activeAudio.duration : 0);
      if (loopFadeEl.checked) startXfadeLoop(url, activeAudio.currentTime || 0);
    }
  } catch (_) { currentPeaks = null; }
}

function drawWaveform(progress) {
  const dpr = window.devicePixelRatio || 1;
  const rect = pbWaveWrap.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (pbWave.width !== w || pbWave.height !== h) { pbWave.width = w; pbWave.height = h; }

  waveCtx.clearRect(0, 0, w, h);
  const midY = h / 2;
  const playX = progress * w;

  if (!currentPeaks) {
    waveCtx.fillStyle = '#262b3d';
    waveCtx.fillRect(0, midY - 2 * dpr, w, 4 * dpr);
    waveCtx.fillStyle = '#ff4fa3';
    waveCtx.fillRect(0, midY - 2 * dpr, playX, 4 * dpr);
    return;
  }
  const slotW = w / currentPeaks.length;
  const barW = Math.max(1.5 * dpr, slotW * 0.65);
  currentPeaks.forEach((val, i) => {
    const x = i * slotW;
    const amp = Math.max(0.06, val) * (h * 0.82);
    waveCtx.fillStyle = x <= playX ? '#ff4fa3' : '#3a4158';
    waveCtx.fillRect(x, midY - amp / 2, barW, amp);
  });
  waveCtx.fillStyle = '#ffffff';
  waveCtx.fillRect(Math.min(w - 2 * dpr, playX), 0, 2 * dpr, h);
}

function updateSeekLoop() {
  if (xfadeState?.active) {
    const cur = getXfadeCurrentTime();
    drawWaveform(xfadeState.dur > 0 ? cur / xfadeState.dur : 0);
    pbTime.textContent = `${fmtTime(cur)} / ${fmtTime(xfadeState.dur)}`;
    rafId = requestAnimationFrame(updateSeekLoop);
    return;
  }
  if (activeAudio) {
    const dur = activeAudio.duration || 0;
    const cur = activeAudio.currentTime || 0;
    drawWaveform(dur > 0 ? cur / dur : 0);
    pbTime.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  }
  if (activeAudio && !activeAudio.paused) rafId = requestAnimationFrame(updateSeekLoop);
}

function bindAudioToBar(aud) {
  stopXfadeLoop();
  if (activeAudio && activeAudio !== aud) activeAudio.closest('tr')?.classList.remove('playing-row');
  activeAudio = aud;
  playerBar.classList.remove('hidden');
  const row = aud.closest('tr');
  row?.classList.add('playing-row');
  pbTitle.textContent = row?.querySelector('.track-label')?.textContent || 'Audio Track';
  const chCell = row?.firstElementChild?.nextElementSibling;
  pbSub.textContent = chCell ? chCell.textContent : '';
  pbPlayBtn.textContent = aud.paused ? '▶' : '⏸';
  loadWaveform(aud.getAttribute('src'));
}

function seekFromPointer(e) {
  if (!activeAudio) return;
  const rect = pbWaveWrap.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  if (xfadeState) {
    const target = ratio * xfadeState.dur;
    startXfadeLoop(xfadeState.url, target);
    drawWaveform(ratio);
    pbTime.textContent = `${fmtTime(target)} / ${fmtTime(xfadeState.dur)}`;
    return;
  }
  if (!activeAudio.duration) return;
  activeAudio.currentTime = ratio * activeAudio.duration;
  drawWaveform(ratio);
  pbTime.textContent = `${fmtTime(activeAudio.currentTime)} / ${fmtTime(activeAudio.duration)}`;
}

pbWaveWrap.addEventListener('pointerdown', e => { isSeeking = true; pbWaveWrap.setPointerCapture(e.pointerId); seekFromPointer(e); });
pbWaveWrap.addEventListener('pointermove', e => { if (isSeeking) seekFromPointer(e); });
pbWaveWrap.addEventListener('pointerup', e => {
  if (!isSeeking) return;
  isSeeking = false;
  pbWaveWrap.releasePointerCapture(e.pointerId);
  if (xfadeState?.active || (activeAudio && !activeAudio.paused)) {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updateSeekLoop);
  }
});

window.addEventListener('resize', () => {
  if (xfadeState?.active) drawWaveform(getXfadeCurrentTime() / xfadeState.dur);
  else if (activeAudio?.duration) drawWaveform(activeAudio.currentTime / activeAudio.duration);
});

document.addEventListener('play', e => {
  if (e.target.tagName !== 'AUDIO') return;
  if (singlePlayEl.checked) {
    document.querySelectorAll('audio').forEach(aud => { if (aud !== e.target && !aud.paused) aud.pause(); });
  }
  bindAudioToBar(e.target);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(updateSeekLoop);
}, true);

document.addEventListener('pause', e => {
  if (e.target === activeAudio && !xfadeState) { pbPlayBtn.textContent = '▶'; cancelAnimationFrame(rafId); }
}, true);

document.addEventListener('ended', e => {
  if (e.target !== activeAudio || xfadeState) return;
  pbPlayBtn.textContent = '▶';
  cancelAnimationFrame(rafId);
  if (autoNextEl.checked) stepTrack(1);
}, true);

function toggleActivePlay() {
  if (loopFadeEl.checked && activeAudio) {
    const url = activeAudio.getAttribute('src');
    if (xfadeState?.active) {
      const cur = getXfadeCurrentTime();
      stopXfadeLoop();
      activeAudio.currentTime = cur;
      pbPlayBtn.textContent = '▶';
      return;
    } else if (bufferCache.has(url)) {
      startXfadeLoop(url, activeAudio.currentTime || 0);
      return;
    }
  }
  if (!activeAudio) {
    const first = document.querySelector('audio');
    if (first) first.play();
    return;
  }
  activeAudio.paused ? activeAudio.play() : activeAudio.pause();
}

function stepTrack(dir) {
  const list = Array.from(document.querySelectorAll('audio'));
  if (!list.length) return;
  const idx = activeAudio ? list.indexOf(activeAudio) : -1;
  const next = list.at((idx + dir + list.length) % list.length);
  next.currentTime = 0;
  next.play();
  next.closest('tr')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

window.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); toggleActivePlay(); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); stepTrack(1); }
  else if (e.code === 'ArrowUp') { e.preventDefault(); stepTrack(-1); }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const num = Number(e.key);
    if (num >= 0 && num <= ROLE_TAGS.length && activeAudio) {
      e.preventDefault();
      const row = activeAudio.closest('tr');
      const tbody = row?.closest('tbody');
      const sourceName = row?.dataset.source;
      const tracks = tbody?._tracks;
      const track = tracks?.find(t => t.name === sourceName);
      if (track) {
        applyLabelAndAdvance(tbody._folderId, tracks, track, ROLE_TAGS[num], tbody._rerender);
      }
    }
  }
});

window.addEventListener('dragenter', e => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  overlayEl.classList.add('active');
});
window.addEventListener('dragover', e => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) overlayEl.classList.remove('active');
});
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  overlayEl.classList.remove('active');
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', e => handleFiles(e.target.files));

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.awc'));
  if (!files.length) return;
  const fmt = document.getElementById('fmt').value;
  for (const file of files) {
    statusEl.textContent = `Checking cache for ${file.name}...`;
    const checkRes = await fetch(`/check?name=${encodeURIComponent(file.name)}&fmt=${fmt}`);
    const checkData = await checkRes.json();
    if (checkData.cached) { renderGroup(checkData); continue; }

    statusEl.textContent = `Decoding ${file.name} (${(file.size / 1048576).toFixed(2)} MB)...`;
    const res = await fetch(`/upload?name=${encodeURIComponent(file.name)}&fmt=${fmt}`, {
      method: 'POST', body: await file.arrayBuffer()
    });
    renderGroup(await res.json());
  }
  statusEl.textContent = 'Done!';
  zipAllBtn.disabled = false;
}

function buildRowsHtml(tracks) {
  return tracks.map(t => {
    const url = `/file/${encodeURIComponent(t.folder)}/${encodeURIComponent(t.name)}`;
    const displayName = t.draftName || t.name;
    const pills = ROLE_TAGS.map((tag, i) => {
      const active = t.tag === tag ? ' active' : '';
      return `<button type="button" class="tag-pill${active}" data-source="${t.name}" data-tag="${tag}" title="Shortcut: ${i}">${i}:${tag}</button>`;
    }).join('');
    return `<tr data-source="${t.name}">
      <td>
        <code class="track-label">${displayName}</code>
        <span class="tag-pills">${pills}</span>
      </td>
      <td>${t.channels === 2 ? 'Stereo' : 'Mono'}</td>
      <td>${t.duration}s</td>
      <td>${formatBytes(t.size)}</td>
      <td class="preview-col"><audio controls preload="metadata" src="${url}"></audio></td>
      <td><a class="dl" href="${url}" download="${displayName}">Download</a></td>
    </tr>`;
  }).join('');
}

function renderGroup(data) {
  const div = document.createElement('div');
  div.className = 'group';
  if (data.error) {
    div.innerHTML = `<div class="group-header"><strong>${data.file}</strong><span class="badge" style="color:#f87171;">${data.error}</span></div>`;
    resultsEl.prepend(div);
    return;
  }

  recomputeGroupDraftNames(data.tracks);

  let sortKey = 'path';
  let sortAsc = true;
  let visibleTracks = data.tracks;
  const totalBytes = data.tracks.reduce((sum, t) => sum + (t.size || 0), 0);
  const cacheBadge = data.cached ? `<span class="badge" style="color:#4ade80;">Cached</span>` : '';

  div.innerHTML = `
    <div class="group-header">
      <div>
        <strong>${data.file}</strong>
        <span class="badge">Folder: output/${data.id}/</span>
        <span class="badge">${formatBytes(totalBytes)}</span>
        <span class="badge">${data.tracks.length} streams</span>
        ${cacheBadge}
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button type="button" class="secondary save-sorted-btn">Save Sorted (TRACK_${data.id})</button>
        <button type="button" class="secondary save-track-btn">Save All (TRACK_${data.id})</button>
        <a class="dl" href="/zip/${encodeURIComponent(data.id)}">Download ${data.id}.zip</a>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="path">Output Path<span class="arrow">▲</span></th>
          <th>Channels</th>
          <th class="sortable" data-sort="duration">Duration<span class="arrow"></span></th>
          <th class="sortable" data-sort="size">Size<span class="arrow"></span></th>
          <th>Preview</th>
          <th>File</th>
        </tr>
      </thead>
      <tbody>${buildRowsHtml(visibleTracks)}</tbody>
    </table>`;

  const tbody = div.querySelector('tbody');
  const saveSortedBtn = div.querySelector('.save-sorted-btn');
  const saveBtn = div.querySelector('.save-track-btn');

  function rerenderBody(activeAudioRef = activeAudio) {
    const activeSrc = activeAudioRef?.getAttribute('src');
    const wasPlaying = Boolean(activeAudioRef && !activeAudioRef.paused);
    const prevTime = activeAudioRef?.currentTime || 0;
    tbody.innerHTML = buildRowsHtml(visibleTracks);
    if (activeSrc) {
      const matchAud = Array.from(tbody.querySelectorAll('audio')).find(a => a.getAttribute('src') === activeSrc);
      if (matchAud) {
        activeAudioRef = matchAud;
        matchAud.closest('tr')?.classList.add('playing-row');
        pbTitle.textContent = matchAud.closest('tr')?.querySelector('.track-label')?.textContent || pbTitle.textContent;
        if (!xfadeState?.active) {
          matchAud.currentTime = prevTime;
          if (wasPlaying) matchAud.play().catch(() => {});
        }
      }
    }
    return activeAudioRef;
  }

  tbody._folderId = data.id;
  tbody._tracks = data.tracks;
  tbody._rerender = rerenderBody;

  tbody.addEventListener('click', e => {
    const pill = e.target.closest('.tag-pill');
    if (pill) {
      const track = data.tracks.find(t => t.name === pill.dataset.source);
      if (track) applyLabelAndAdvance(data.id, data.tracks, track, pill.dataset.tag, rerenderBody);
      return;
    }
    const row = e.target.closest('tr');
    if (row && e.target.tagName !== 'AUDIO') {
      e.preventDefault();
      const track = data.tracks.find(t => t.name === row.dataset.source);
      if (track) playTrack(track);
    }
  });

  function playTrack(track) {
    const url = `/file/${encodeURIComponent(track.folder)}/${encodeURIComponent(track.name)}`;
    let aud = document.querySelector(`audio[src="${url}"]`);
    if (!aud) {
      aud = document.createElement('audio');
      aud.setAttribute('src', url);
      aud.setAttribute('preload', 'metadata');
      aud.addEventListener('play', () => bindAudioToBar(aud), { once: true });
      const row = document.querySelector(`tr[data-source="${track.name}"]`);
      row?.querySelector('.preview-col')?.appendChild(aud);
    }
    if (singlePlayEl.checked) {
      document.querySelectorAll('audio').forEach(a => { if (a !== aud && !a.paused) a.pause(); });
    }
    aud.play();
  }

  async function runSave(btn, onlyTagged) {
    recomputeGroupDraftNames(data.tracks);
    const sourceTracks = onlyTagged ? data.tracks.filter(t => Boolean(t.tag)) : data.tracks;
    if (!sourceTracks.length) {
      statusEl.textContent = `No labeled bits to save for ${data.id}.`;
      return;
    }
    btn.disabled = true;
    statusEl.textContent = `Saving ${sourceTracks.length} bit(s) to TRACK_${data.id}...`;
    try {
      const items = sourceTracks.map(t => ({
        source_name: t.name,
        target_name: t.draftName || t.name
      }));
      const res = await fetch('/save_track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: data.id, items })
      });
      const out = await res.json();
      statusEl.textContent = `Saved ${(out.saved || []).length} files to output/${out.folder}/`;
    } finally {
      btn.disabled = false;
    }
  }

  saveSortedBtn.addEventListener('click', () => runSave(saveSortedBtn, true));
  saveBtn.addEventListener('click', () => runSave(saveBtn, false));

  const headers = div.querySelectorAll('th.sortable');
  headers.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      sortAsc = (sortKey === key) ? !sortAsc : (key === 'path');
      sortKey = key;
      headers.forEach(h => { h.querySelector('.arrow').textContent = h.dataset.sort === sortKey ? (sortAsc ? '▲' : '▼') : ''; });
      visibleTracks = Array.from(data.tracks).sort((a, b) => {
        if (sortKey === 'duration') return sortAsc ? (a.duration - b.duration) : (b.duration - a.duration);
        if (sortKey === 'size') return sortAsc ? ((a.size || 0) - (b.size || 0)) : ((b.size || 0) - (a.size || 0));
        const pA = `${a.folder}/${a.draftName || a.name}`, pB = `${b.folder}/${b.draftName || b.name}`;
        return sortAsc ? pA.localeCompare(pB, undefined, { numeric: true }) : pB.localeCompare(pA, undefined, { numeric: true });
      });
      rerenderBody();
    });
  });

  resultsEl.prepend(div);
}

function downloadAllZip() { window.location.href = '/zip_all'; }

async function clearWorkspace() {
  await fetch('/clear', { method: 'POST' });
  resultsEl.innerHTML = '';
  statusEl.textContent = 'Cleared output folder.';
  zipAllBtn.disabled = true;
  stopXfadeLoop();
  cancelAnimationFrame(rafId);
  if (activeAudio) { activeAudio.pause(); activeAudio = null; }
  currentPeaks = null;
  waveCache.clear();
  bufferCache.clear();
  playerBar.classList.add('hidden');
}
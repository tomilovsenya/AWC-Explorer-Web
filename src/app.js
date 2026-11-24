const fileInput = document.getElementById('fileInput');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const zipAllBtn = document.getElementById('zipAllBtn');
const groupNavEl = document.getElementById('groupNav');
const autoPlayOnLabelEl = document.getElementById('autoPlayOnLabel');
const autoResortOnLabelEl = document.getElementById('autoResortOnLabel');
const overlayEl = document.getElementById('globalDropOverlay');
const goTopBtn = document.getElementById('goTopBtn');

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

const ROLE_TAGS = ['INTRO', 'OUTRO', 'PAD', 'PERC', 'LEAD', 'BASS', 'DRUMS', 'SYNTH', 'OTHER', 'CALM', 'JUNK'];
const TRACK_GROUPS = ['A', 'B', 'C', 'D'];

const player = new Audio();
player.preload = 'metadata';

let activeTrack = null;
let activeUrl = null;
let isSeeking = false;
let rafId = null;
let dragDepth = 0;
let audioCtx = null;
let currentPeaks = null;
let xfadeState = null;

const waveCache = new Map();
const bufferCache = new Map();
const metadataSaveQueues = new Map();
let groupNavCounter = 0;

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

function getTrackDisplayName(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function updateGroupProgress(group, tracks) {
  if (!group) return;
  const progress = group.querySelector('.group-progress-bar');
  if (!progress) return;

  const counts = new Map(ROLE_TAGS.map(tag => [tag, 0]));
  tracks.forEach(track => {
    if (counts.has(track.tag)) counts.set(track.tag, counts.get(track.tag) + 1);
  });
  const labeledCount = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  const unlabeledCount = tracks.length - labeledCount;
  const total = tracks.length || 1;
  const segments = ROLE_TAGS
    .filter(tag => counts.get(tag) > 0)
    .map(tag => {
      const count = counts.get(tag);
      const percentage = count / total * 100;
      return `<span class="progress-segment tag-color-${tag.toLowerCase()}" data-category="${tag}" style="width:${percentage}%" title="${tag}: ${count} (${percentage.toFixed(1)}%)"><span class="progress-segment-label">${tag}</span></span>`;
    });
  if (unlabeledCount > 0) {
    const percentage = unlabeledCount / total * 100;
    segments.push(`<span class="progress-segment progress-unlabeled" data-category="" style="width:${percentage}%" title="Unlabeled: ${unlabeledCount} (${percentage.toFixed(1)}%)"><span class="progress-segment-label">Unlabeled</span></span>`);
  }
  progress.innerHTML = segments.join('');
  const legend = group.querySelector('.group-progress-labels');
  const legendItems = [];
  progress.querySelectorAll('.progress-segment').forEach(segment => {
    const label = segment.querySelector('.progress-segment-label');
    const style = getComputedStyle(segment);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const border = parseFloat(style.borderRightWidth);
    const availableWidth = segment.getBoundingClientRect().width - padding - border;
    if (label.getBoundingClientRect().width > availableWidth) {
      label.hidden = true;
      const category = segment.dataset.category;
      const labelClass = category ? `tag-color-${category.toLowerCase()}` : 'progress-label-unlabeled';
      legendItems.push(`<span class="progress-label ${labelClass}">${category || 'Unlabeled'}</span>`);
    }
  });
  legend.innerHTML = legendItems.join('');
  legend.hidden = legendItems.length === 0;
  progress.setAttribute('aria-valuemax', String(total));
  progress.setAttribute('aria-valuenow', String(labeledCount));
  progress.setAttribute('aria-valuetext', `${labeledCount} of ${tracks.length} tracks labeled`);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function getTrackUrl(track) {
  return `/file/${encodeURIComponent(track.folder)}/${encodeURIComponent(track.name)}`;
}

function refreshGroupNavigation() {
  const groups = Array.from(resultsEl.querySelectorAll('.group')).filter(group => group.querySelector('table'));
  groupNavEl.replaceChildren();
  groupNavEl.hidden = groups.length < 2;
  document.body.classList.toggle('has-group-nav', groups.length >= 2);
  if (groups.length < 2) {
    document.body.style.removeProperty('--group-nav-width');
    return;
  }

  const label = document.createElement('span');
  label.textContent = 'Jump to:';
  groupNavEl.append(label);
  groups.forEach((group, index) => {
    const tableNumber = index + 1;
    const nameInput = group.querySelector('.awc-display-name');
    const folderId = group.querySelector('tbody')?._folderId;
    const link = document.createElement('a');
    link.href = `#${group.id}`;
    link.textContent = `#${tableNumber}`;
    link.title = nameInput?.value.trim() || `AWC ${folderId}`;
    link.addEventListener('click', event => {
      event.preventDefault();
      group.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    groupNavEl.append(link);
  });
  document.body.style.setProperty('--group-nav-width', `${groupNavEl.offsetWidth}px`);
}

function getCategoryOrder(track) {
  const idx = track.tag ? ROLE_TAGS.indexOf(track.tag) : -1;
  return idx >= 0 ? idx : 999;
}

function getTrackGroupOrder(track) {
  if (track.tag === 'JUNK') return TRACK_GROUPS.length;
  const idx = TRACK_GROUPS.indexOf(track.subgroup);
  return idx >= 0 ? idx : TRACK_GROUPS.length;
}

function recomputeGroupDraftNames(tracks) {
  const counts = new Map();
  tracks.forEach(t => {
    if (!t.tag) {
      t.draftName = t.name;
      return;
    }
    if (t.tag === 'JUNK') t.subgroup = null;
    const subgroup = TRACK_GROUPS.includes(t.subgroup) ? t.subgroup : '';
    const countKey = `${t.tag}:${subgroup}`;
    const nextNum = (counts.get(countKey) || 0) + 1;
    counts.set(countKey, nextNum);

    const dot = t.name.lastIndexOf('.');
    const ext = dot >= 0 ? t.name.slice(dot) : '';
    const idMatch = t.name.match(/^(\d+)/);
    const prefix = idMatch ? idMatch[1] : (t.folder || 'TRACK');
    const subgroupPart = subgroup ? `_${subgroup}` : '';
    t.draftName = `${prefix}_${t.tag}${subgroupPart}_${nextNum}${ext}`;
  });
}

function persistGroupLabels(folderId, tracks, displayName) {
  const labels = {};
  tracks.forEach(t => {
    const metadata = {};
    if (t.tag) metadata.category = t.tag;
    if (t.tag && t.tag !== 'JUNK' && TRACK_GROUPS.includes(t.subgroup)) metadata.subgroup = t.subgroup;
    if (Object.keys(metadata).length) labels[t.name] = metadata;
  });
  const previousSave = metadataSaveQueues.get(folderId) || Promise.resolve();
  const save = previousSave.catch(() => {}).then(async () => {
    const response = await fetch('/save_labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folderId, display_name: displayName, labels })
    });
    if (!response.ok) throw new Error(`Metadata save failed (${response.status})`);
  });
  metadataSaveQueues.set(folderId, save);
  return save;
}

function syncRowHighlight() {
  document.querySelectorAll('tbody tr').forEach(tr => {
    const isMatch = activeTrack && tr.dataset.folder === activeTrack.folder && tr.dataset.source === activeTrack.name;
    tr.classList.toggle('playing-row', Boolean(isMatch));
  });
}

function updateGroupRowsDOM(tbody, tracks) {
  const byName = new Map(tracks.map(t => [t.name, t]));
  tbody.querySelectorAll('tr').forEach(tr => {
    const t = byName.get(tr.dataset.source);
    if (!t) return;
    const downloadName = t.draftName || t.name;
    const displayName = getTrackDisplayName(downloadName);
    const labelEl = tr.querySelector('.track-label');
    if (labelEl && labelEl.textContent !== displayName) {
      labelEl.textContent = displayName;
    }
    const dlEl = tr.querySelector('a.dl');
    if (dlEl) {
      dlEl.setAttribute('download', downloadName);
      dlEl.setAttribute('aria-label', `Download ${downloadName}`);
      dlEl.setAttribute('title', `Download ${downloadName}`);
    }
    tr.querySelectorAll('.tag-pill').forEach(pill => {
      pill.classList.toggle('active', pill.dataset.tag === t.tag);
    });
    const subgroupPills = tr.querySelector('.subgroup-pills');
    if (subgroupPills) subgroupPills.hidden = t.tag === 'JUNK';
    tr.querySelectorAll('.subgroup-pill').forEach(pill => {
      const active = pill.dataset.subgroup === t.subgroup;
      pill.disabled = !t.tag || t.tag === 'JUNK';
      pill.classList.toggle('active', active);
      pill.setAttribute('aria-pressed', String(active));
    });
  });

  if (activeTrack && byName.has(activeTrack.name)) {
    pbTitle.textContent = getTrackDisplayName(activeTrack.draftName || activeTrack.name);
  }
}

function applyTrackSubgroup(folderId, tracks, track, subgroup, tbody, toggleSelection = false) {
  if (!track?.tag || track.tag === 'JUNK' || !TRACK_GROUPS.includes(subgroup)) return;
  const previousSubgroup = track.subgroup;
  const clearing = toggleSelection && previousSubgroup === subgroup;
  const nextSubgroup = clearing ? null : subgroup;
  const shouldAdvance = previousSubgroup !== nextSubgroup;
  const previousVisible = tbody?._visibleTracks ? Array.from(tbody._visibleTracks) : Array.from(tracks);
  const previousIndex = previousVisible.findIndex(item =>
    item.folder === track.folder && item.name === track.name
  );
  const nextTrack = previousIndex >= 0 && previousVisible.length
    ? previousVisible[(previousIndex + 1) % previousVisible.length]
    : null;

  track.subgroup = nextSubgroup;
  recomputeGroupDraftNames(tracks);
  tbody?._sortByCategory?.();
  if (tbody) updateGroupRowsDOM(tbody, tracks);
  persistGroupLabels(folderId, tracks, tbody?._groupDisplayName || folderId)
    .catch(error => { statusEl.textContent = `Unable to save labels: ${error.message}`; });

  if (shouldAdvance && autoPlayOnLabelEl?.checked && nextTrack) {
    playTrack(nextTrack);
    const row = tbody?.querySelector(`tr[data-source="${CSS.escape(nextTrack.name)}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function applyLabelAndAdvance(folderId, tracks, track, tag, tbody) {
  const prevVisible = tbody?._visibleTracks ? Array.from(tbody._visibleTracks) : Array.from(tracks);
  const prevIdx = prevVisible.findIndex(t => t.folder === track.folder && t.name === track.name);
  let nextUnlabeled = null;
  if (prevIdx >= 0) {
    for (let i = prevIdx + 1; i < prevVisible.length; i++) {
      if (!prevVisible[i].tag) {
        nextUnlabeled = prevVisible[i];
        break;
      }
    }
  }

  track.tag = tag;
  recomputeGroupDraftNames(tracks);
  const group = tbody?.closest('.group');
  updateGroupProgress(group, tracks);
  persistGroupLabels(folderId, tracks, tbody?._groupDisplayName || folderId)
    .catch(error => { statusEl.textContent = `Unable to save labels: ${error.message}`; });

  const didResort = Boolean(tbody && autoResortOnLabelEl?.checked && tbody._sortByCategory?.());
  if (tbody && !didResort) {
    updateGroupRowsDOM(tbody, tracks);
  }

  if (autoPlayOnLabelEl?.checked) {
    if (didResort && nextUnlabeled) {
      playTrack(nextUnlabeled);
      const row = tbody.querySelector(`tr[data-source="${CSS.escape(nextUnlabeled.name)}"]`);
      row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      stepTrack(1);
    }
  }
}

function stopXfadeLoop() {
  if (!xfadeState) return;
  xfadeState.active = false;
  clearTimeout(xfadeState.timer);
  xfadeState.sources.forEach(src => {
    try { src.stop(); src.disconnect(); } catch (_) {}
  });
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
  if (!player.paused) player.pause();

  const dur = audioBuf.duration;
  const fadeDur = Math.min(dur * 0.4, Math.max(0.04, Math.min(2.5, dur * 0.03)));
  const stepDur = Math.max(0.05, dur - fadeDur);
  const state = {
    active: true,
    url,
    dur,
    fadeDur,
    stepDur,
    timer: null,
    sources: new Set(),
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
  if (!activeUrl) return;
  if (loopFadeEl.checked && bufferCache.has(activeUrl)) {
    startXfadeLoop(activeUrl, player.currentTime || 0);
  } else if (!loopFadeEl.checked && xfadeState) {
    const cur = getXfadeCurrentTime();
    stopXfadeLoop();
    player.currentTime = cur;
    player.play().catch(() => {});
  }
});

async function loadWaveform(url) {
  currentPeaks = null;
  drawWaveform(0);
  if (waveCache.has(url)) {
    currentPeaks = waveCache.get(url);
    drawWaveform(player.duration ? player.currentTime / player.duration : 0);
    if (loopFadeEl.checked && bufferCache.has(url) && activeUrl === url) {
      startXfadeLoop(url, player.currentTime || 0);
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

    if (activeUrl === url) {
      currentPeaks = normPeaks;
      drawWaveform(player.duration ? player.currentTime / player.duration : 0);
      if (loopFadeEl.checked) startXfadeLoop(url, player.currentTime || 0);
    }
  } catch (_) {
    currentPeaks = null;
  }
}

function drawWaveform(progress) {
  const dpr = window.devicePixelRatio || 1;
  const rect = pbWaveWrap.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (pbWave.width !== w || pbWave.height !== h) {
    pbWave.width = w;
    pbWave.height = h;
  }

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
  if (activeUrl) {
    const dur = player.duration || 0;
    const cur = player.currentTime || 0;
    drawWaveform(dur > 0 ? cur / dur : 0);
    pbTime.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  }
  if (!player.paused) rafId = requestAnimationFrame(updateSeekLoop);
}

function centerTrackRow(track) {
  const row = Array.from(document.querySelectorAll('tbody tr')).find(candidate =>
    candidate.dataset.folder === track.folder && candidate.dataset.source === track.name
  );
  row?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
}

function selectTrack(track) {
  if (!track) return null;
  stopXfadeLoop();
  player.pause();

  const url = getTrackUrl(track);
  activeTrack = track;
  activeUrl = url;

  playerBar.classList.remove('hidden');
  syncRowHighlight();

  pbTitle.textContent = getTrackDisplayName(track.draftName || track.name);
  pbSub.textContent = track.channels === 2 ? 'Stereo' : 'Mono';
  player.src = url;
  player.currentTime = 0;
  currentPeaks = waveCache.get(url) || null;
  pbPlayBtn.textContent = '▶';
  pbTime.textContent = `0:00 / ${fmtTime(track.duration || 0)}`;
  drawWaveform(0);
  return url;
}

function playTrack(track) {
  const url = selectTrack(track);
  if (!url) return;
  centerTrackRow(track);

  if (loopFadeEl.checked && bufferCache.has(url)) {
    loadWaveform(url);
    startXfadeLoop(url, 0);
  } else {
    player.play().catch(() => {});
    loadWaveform(url);
  }
}

function seekFromPointer(e) {
  if (!activeUrl) return;
  const rect = pbWaveWrap.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  if (xfadeState) {
    const target = ratio * xfadeState.dur;
    startXfadeLoop(xfadeState.url, target);
    drawWaveform(ratio);
    pbTime.textContent = `${fmtTime(target)} / ${fmtTime(xfadeState.dur)}`;
    return;
  }
  if (!player.duration) return;
  player.currentTime = ratio * player.duration;
  drawWaveform(ratio);
  pbTime.textContent = `${fmtTime(player.currentTime)} / ${fmtTime(player.duration)}`;
}

pbWaveWrap.addEventListener('pointerdown', e => {
  isSeeking = true;
  pbWaveWrap.setPointerCapture(e.pointerId);
  seekFromPointer(e);
});
pbWaveWrap.addEventListener('pointermove', e => {
  if (isSeeking) seekFromPointer(e);
});
pbWaveWrap.addEventListener('pointerup', e => {
  if (!isSeeking) return;
  isSeeking = false;
  pbWaveWrap.releasePointerCapture(e.pointerId);
  if (xfadeState?.active || !player.paused) {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updateSeekLoop);
  }
});

window.addEventListener('resize', () => {
  if (xfadeState?.active) drawWaveform(getXfadeCurrentTime() / xfadeState.dur);
  else if (player.duration) drawWaveform(player.currentTime / player.duration);
});

player.addEventListener('play', () => {
  pbPlayBtn.textContent = '⏸';
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(updateSeekLoop);
});

player.addEventListener('pause', () => {
  if (!xfadeState) {
    pbPlayBtn.textContent = '▶';
    cancelAnimationFrame(rafId);
  }
});

player.addEventListener('ended', () => {
  if (xfadeState) return;
  pbPlayBtn.textContent = '▶';
  cancelAnimationFrame(rafId);
  if (autoNextEl.checked) stepTrack(1);
});

function getAllVisibleTracks() {
  const items = [];
  document.querySelectorAll('.group tbody').forEach(tbody => {
    const visible = tbody._visibleTracks || [];
    visible.forEach(track => items.push({ track, tbody }));
  });
  return items;
}

function toggleActivePlay() {
  if (loopFadeEl.checked && activeUrl) {
    if (xfadeState?.active) {
      const cur = getXfadeCurrentTime();
      stopXfadeLoop();
      player.currentTime = cur;
      pbPlayBtn.textContent = '▶';
      return;
    } else if (bufferCache.has(activeUrl)) {
      startXfadeLoop(activeUrl, player.currentTime || 0);
      return;
    }
  }
  if (!activeUrl) {
    const all = getAllVisibleTracks();
    if (all.length) playTrack(all[0].track);
    return;
  }
  if (player.paused) {
    player.play().catch(() => {});
    if (!currentPeaks) loadWaveform(activeUrl);
  } else {
    player.pause();
  }
}

function stepTrack(dir) {
  const all = getAllVisibleTracks();
  if (!all.length) return;
  const idx = activeTrack
    ? all.findIndex(item => item.track.folder === activeTrack.folder && item.track.name === activeTrack.name)
    : -1;
  const next = all.at((idx + dir + all.length) % all.length);
  if (!next) return;
  playTrack(next.track);
}

window.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') {
    e.preventDefault();
    toggleActivePlay();
  } else if (e.code === 'ArrowDown') {
    e.preventDefault();
    stepTrack(1);
  } else if (e.code === 'ArrowUp') {
    e.preventDefault();
    stepTrack(-1);
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const subgroup = e.key.toUpperCase();
    if (TRACK_GROUPS.includes(subgroup) && activeTrack) {
      const tbody = Array.from(document.querySelectorAll('.group tbody')).find(tb => tb._folderId === activeTrack.folder);
      const tracks = tbody?._tracks;
      const track = tracks?.find(t => t.name === activeTrack.name);
      if (track?.tag && track.tag !== 'JUNK') {
        e.preventDefault();
        applyTrackSubgroup(tbody._folderId, tracks, track, subgroup, tbody, true);
      }
    } else {
      const num = Number(e.key);
      if (num >= 0 && num < 10 && activeTrack) {
        e.preventDefault();
        const tbody = Array.from(document.querySelectorAll('.group tbody')).find(tb => tb._folderId === activeTrack.folder);
        const tracks = tbody?._tracks;
        const track = tracks?.find(t => t.name === activeTrack.name);
        if (track) {
          applyLabelAndAdvance(tbody._folderId, tracks, track, ROLE_TAGS[num], tbody);
        }
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
  let duplicateCount = 0;
  for (const file of files) {
    statusEl.textContent = `Checking cache for ${file.name}...`;
    const checkRes = await fetch(`/check?name=${encodeURIComponent(file.name)}&fmt=${fmt}`);
    const checkData = await checkRes.json();
    if (checkData.cached) {
      if (renderGroup(checkData) === false) duplicateCount++;
      hidePlayerBarIfNoTables();
      continue;
    }

    statusEl.textContent = `Decoding ${file.name} (${(file.size / 1048576).toFixed(2)} MB)...`;
    const res = await fetch(`/upload?name=${encodeURIComponent(file.name)}&fmt=${fmt}`, {
      method: 'POST',
      body: await file.arrayBuffer()
    });
    if (renderGroup(await res.json()) === false) duplicateCount++;
    hidePlayerBarIfNoTables();
  }
  statusEl.textContent = duplicateCount
    ? `Done! Skipped ${duplicateCount} duplicate AWC table${duplicateCount === 1 ? '' : 's'}.`
    : 'Done!';
  zipAllBtn.disabled = false;
}

function buildRowsHtml(tracks) {
  return tracks.map(t => {
    const url = getTrackUrl(t);
    const downloadName = t.draftName || t.name;
    const displayName = getTrackDisplayName(downloadName);
    const isPlaying = activeTrack && activeTrack.folder === t.folder && activeTrack.name === t.name;
    const pills = ROLE_TAGS.map((tag, i) => {
      const active = t.tag === tag ? ' active' : '';
      const shortcut = i < 10 ? `${i}:` : '';
      const title = i < 10 ? `Shortcut: ${i}` : 'Broken or junk track';
      const compactLabel = i < 10 ? i : 'J';
      return `<button type="button" class="tag-pill tag-color-${tag.toLowerCase()}${active}" data-source="${t.name}" data-tag="${tag}" aria-label="Set ${tag} category" title="${title}"><span class="tag-pill-full">${shortcut}${tag}</span><span class="tag-pill-compact" aria-hidden="true">${compactLabel}</span></button>`;
    }).join('');
    const subgroupPills = TRACK_GROUPS.map(letter => {
      const active = t.subgroup === letter ? ' active' : '';
      const disabled = t.tag && t.tag !== 'JUNK' ? '' : ' disabled';
      const title = t.tag && t.tag !== 'JUNK'
        ? `Similarity group ${letter} (shortcut: ${letter}; press or click again to clear)`
        : 'Choose a non-JUNK category first';
      return `<button type="button" class="subgroup-pill${active}" data-source="${t.name}" data-subgroup="${letter}" aria-label="Similarity group ${letter}" aria-pressed="${t.subgroup === letter}" aria-keyshortcuts="${letter}" title="${title}"${disabled}>${letter}</button>`;
    }).join('');
    const subgroupHidden = t.tag === 'JUNK' ? ' hidden' : '';
    return `<tr data-folder="${t.folder}" data-source="${t.name}" class="${isPlaying ? 'playing-row' : ''}">
      <td class="track-name-cell"><code class="track-label">${displayName}</code></td>
      <td class="category-cell"><span class="tag-pills">${pills}</span></td>
      <td class="group-cell"><span class="subgroup-pills"${subgroupHidden}>${subgroupPills}</span></td>
      <td class="duration-cell"><span class="mobile-cell-label">Duration: </span>${t.duration}s</td>
      <td class="size-cell"><span class="mobile-cell-label">Size: </span>${formatBytes(t.size)}</td>
      <td class="file-cell"><a class="dl track-download" href="${url}" download="${escapeHtml(downloadName)}" aria-label="Download ${escapeHtml(downloadName)}" title="Download ${escapeHtml(downloadName)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 20h16"/></svg></a></td>
    </tr>`;
  }).join('');
}

function renderGroup(data) {
  if (data.id && !data.error) {
    const existingGroup = Array.from(resultsEl.querySelectorAll('.group')).find(
      group => group.querySelector('tbody')?._folderId === data.id
    );
    if (existingGroup) {
      existingGroup.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return false;
    }
  }

  const div = document.createElement('div');
  div.className = 'group';
  div.id = `awc-group-${++groupNavCounter}`;
  if (data.error) {
    div.innerHTML = `<div class="group-header"><strong>${escapeHtml(data.file)}</strong><span class="badge" style="color:#f87171;">${escapeHtml(data.error)}</span></div>`;
    resultsEl.prepend(div);
    hidePlayerBarIfNoTables();
    return;
  }

  data.display_name = data.display_name || data.file;
  recomputeGroupDraftNames(data.tracks);

  let sortKey = 'path';
  let sortAsc = true;
  let visibleTracks = data.tracks;
  const totalBytes = data.tracks.reduce((sum, t) => sum + (t.size || 0), 0);
  const cacheBadge = data.cached ? `<span class="badge" style="color:#4ade80;">Cached</span>` : '';
  const originalNameBadge = `<span class="badge original-awc-name"${data.display_name === data.file ? ' hidden' : ''}>Original AWC: ${escapeHtml(data.file)}</span>`;
  const formatMatch = data.tracks[0]?.name.match(/\.([^.]+)$/);
  const formatBadge = formatMatch
    ? `<span class="badge">Format: ${escapeHtml(formatMatch[1].toUpperCase())}</span>`
    : '';
  const mobileCategoryLegend = ROLE_TAGS.map((tag, index) => {
    const key = index < 10 ? index : 'J';
    return `<span class="mobile-category-key tag-color-${tag.toLowerCase()}"><kbd>${key}</kbd>${tag}</span>`;
  }).join('');

  div.innerHTML = `
    <div class="group-header">
      <div class="group-main">
        <input type="text" class="awc-display-name" aria-label="AWC display name" title="Edit the name used for this AWC" value="${escapeHtml(data.display_name)}">
        <div class="group-meta">
          <span class="badge">Folder: output/${data.id}/</span>
          ${originalNameBadge}
          ${formatBadge}
          <span class="badge">${formatBytes(totalBytes)}</span>
          <span class="badge">${data.tracks.length} streams</span>
          ${cacheBadge}
        </div>
      </div>
      <div class="group-actions">
        <button type="button" class="secondary group-action-btn close-table-btn" aria-label="Close AWC table" title="Close table">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
        <button type="button" class="secondary group-action-btn save-sorted-btn" aria-label="Save categorized tracks" title="Save labeled tracks to TRACK_${data.id} - ${escapeHtml(data.display_name)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 10h10M4 15h7M17 13v7m-3-3 3 3 3-3"/></svg>
        </button>
        <button type="button" class="secondary group-action-btn save-track-btn" aria-label="Save all tracks" title="Save all tracks to TRACK_${data.id}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h12l3 3v15H4V3h1ZM8 3v6h8V3M8 21v-8h8v8"/></svg>
        </button>
        <a class="dl group-action-btn group-action-link" href="/zip/${encodeURIComponent(data.id)}" aria-label="Download ${data.id}.zip" title="Download ${data.id}.zip">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 20h16"/></svg>
        </a>
      </div>
      <div class="group-progress group-progress-bar" role="progressbar" aria-label="Track category distribution" aria-valuemin="0"></div>
      <div class="group-progress-labels" aria-label="Categories requiring more label space" hidden></div>
      <details class="mobile-category-legend">
        <summary>Category key</summary>
        <div class="mobile-category-legend-items">${mobileCategoryLegend}</div>
      </details>
    </div>
    <div class="mobile-sort-controls">
      <label for="${div.id}-sort-key">Sort:</label>
      <select id="${div.id}-sort-key" class="mobile-sort-key" aria-label="Sort tracks by">
        <option value="path">Output Path</option>
        <option value="category">Category</option>
        <option value="duration">Duration</option>
        <option value="size">Size</option>
      </select>
      <button type="button" class="mobile-sort-direction" aria-label="Reverse sort direction">Asc ↑</button>
    </div>
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="path">Output Path<span class="arrow">▲</span></th>
          <th class="sortable" data-sort="category">Category<span class="arrow"></span></th>
          <th>Group</th>
          <th class="sortable" data-sort="duration">Duration<span class="arrow"></span></th>
          <th class="sortable" data-sort="size">Size<span class="arrow"></span></th>
          <th>Download</th>
        </tr>
      </thead>
      <tbody>${buildRowsHtml(visibleTracks)}</tbody>
    </table>`;

  updateGroupProgress(div, data.tracks);
  const tbody = div.querySelector('tbody');
  const displayNameInput = div.querySelector('.awc-display-name');
  const originalNameBadgeEl = div.querySelector('.original-awc-name');
  const saveSortedBtn = div.querySelector('.save-sorted-btn');
  const saveBtn = div.querySelector('.save-track-btn');
  const progress = div.querySelector('.group-progress-bar');
  const headers = div.querySelectorAll('th.sortable');
  const mobileSortSelect = div.querySelector('.mobile-sort-key');
  const mobileSortDirection = div.querySelector('.mobile-sort-direction');

  function updateMobileSortControls() {
    mobileSortSelect.value = sortKey;
    mobileSortDirection.textContent = sortAsc ? 'Asc ↑' : 'Desc ↓';
    mobileSortDirection.setAttribute(
      'aria-label',
      `${sortAsc ? 'Ascending' : 'Descending'} sort order; activate to reverse`
    );
  }

  function sortTracksByKey(key, toggleDirection) {
    sortAsc = toggleDirection ? ((sortKey === key) ? !sortAsc : (key === 'path' || key === 'category')) : sortAsc;
    sortKey = key;
    progress.classList.toggle('category-sort-active', sortKey === 'category');
    headers.forEach(h => {
      h.querySelector('.arrow').textContent = h.dataset.sort === sortKey ? (sortAsc ? '▲' : '▼') : '';
    });
    visibleTracks = Array.from(data.tracks).sort((a, b) => {
      if (sortKey === 'category') {
        const cA = getCategoryOrder(a);
        const cB = getCategoryOrder(b);
        if (cA !== cB) return sortAsc ? (cA - cB) : (cB - cA);
        const gA = getTrackGroupOrder(a);
        const gB = getTrackGroupOrder(b);
        if (gA !== gB) return sortAsc ? (gA - gB) : (gB - gA);
      }
      if (sortKey === 'duration') return sortAsc ? (a.duration - b.duration) : (b.duration - a.duration);
      if (sortKey === 'size') return sortAsc ? ((a.size || 0) - (b.size || 0)) : ((b.size || 0) - (a.size || 0));
      const pA = `${a.folder}/${a.draftName || a.name}`;
      const pB = `${b.folder}/${b.draftName || b.name}`;
      return sortAsc ? pA.localeCompare(pB, undefined, { numeric: true }) : pB.localeCompare(pA, undefined, { numeric: true });
    });
    tbody._visibleTracks = visibleTracks;
    tbody.innerHTML = buildRowsHtml(visibleTracks);
    updateMobileSortControls();
  }

  mobileSortSelect.addEventListener('change', () => sortTracksByKey(mobileSortSelect.value, true));
  mobileSortDirection.addEventListener('click', () => sortTracksByKey(sortKey, true));
  updateMobileSortControls();

  tbody._folderId = data.id;
  tbody._groupDisplayName = data.display_name;
  tbody._tracks = data.tracks;
  tbody._visibleTracks = visibleTracks;
  tbody._sortByCategory = () => {
    if (sortKey !== 'category') return false;
    sortTracksByKey('category', false);
    return true;
  };

  progress.addEventListener('click', event => {
    if (sortKey !== 'category') return;
    const segment = event.target.closest('.progress-segment');
    if (!segment || !progress.contains(segment)) return;
    const category = segment.dataset.category;
    const target = visibleTracks.find(track =>
      category ? track.tag === category : getCategoryOrder(track) === 999
    );
    if (!target) return;
    selectTrack(target);
    const row = Array.from(tbody.rows).find(candidate => candidate.dataset.source === target.name);
    if (!row) return;
    const groupHeader = progress.closest('.group-header');
    const stickyTop = parseFloat(getComputedStyle(groupHeader).top) || 0;
    const stickyHeight = groupHeader.offsetHeight + div.querySelector('thead').offsetHeight;
    window.scrollTo({
      top: window.scrollY + row.getBoundingClientRect().top - stickyTop - stickyHeight,
      behavior: 'smooth'
    });
  });

  tbody.addEventListener('click', e => {
    if (e.target.closest('a.dl')) return;
    const pill = e.target.closest('.tag-pill');
    if (pill) {
      const track = data.tracks.find(t => t.name === pill.dataset.source);
      if (track) applyLabelAndAdvance(data.id, data.tracks, track, pill.dataset.tag, tbody);
      return;
    }
    const subgroupPill = e.target.closest('.subgroup-pill');
    if (subgroupPill) {
      const track = data.tracks.find(t => t.name === subgroupPill.dataset.source);
      if (track) applyTrackSubgroup(data.id, data.tracks, track, subgroupPill.dataset.subgroup, tbody, true);
      return;
    }
    const row = e.target.closest('tr');
    if (row) {
      const track = data.tracks.find(t => t.name === row.dataset.source);
      if (track) playTrack(track);
    }
  });

  displayNameInput.addEventListener('change', () => {
    data.display_name = displayNameInput.value.trim() || data.file;
    displayNameInput.value = data.display_name;
    tbody._groupDisplayName = data.display_name;
    originalNameBadgeEl.hidden = data.display_name === data.file;
    refreshGroupNavigation();
    persistGroupLabels(data.id, data.tracks, data.display_name)
      .then(() => { statusEl.textContent = `Saved AWC name for ${data.file}.`; })
      .catch(error => { statusEl.textContent = `Unable to save AWC name: ${error.message}`; });
  });

  async function runSave(btn, onlyTagged) {
    recomputeGroupDraftNames(data.tracks);
    updateGroupRowsDOM(tbody, data.tracks);
    const sourceTracks = onlyTagged ? data.tracks.filter(t => Boolean(t.tag)) : data.tracks;
    if (!sourceTracks.length) {
      statusEl.textContent = `No labeled bits to save for ${data.id}.`;
      return;
    }
    btn.disabled = true;
    const targetLabel = onlyTagged
      ? `TRACK_${data.id} - ${data.display_name}`
      : `TRACK_${data.id}`;
    statusEl.textContent = `Saving ${sourceTracks.length} bit(s) to ${targetLabel}...`;
    try {
      await metadataSaveQueues.get(data.id);
      const items = sourceTracks.map(t => ({
        source_name: t.name,
        target_name: t.draftName || t.name
      }));
      const res = await fetch('/save_track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder: data.id,
          items,
          include_name: onlyTagged,
          display_name: data.display_name
        })
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const out = await res.json();
      statusEl.textContent = `Saved ${(out.saved || []).length} files to output/${out.folder}/`;
    } catch (error) {
      statusEl.textContent = `Unable to save tracks: ${error.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  saveSortedBtn.addEventListener('click', () => runSave(saveSortedBtn, true));
  saveBtn.addEventListener('click', () => runSave(saveBtn, false));

  headers.forEach(th => {
    th.addEventListener('click', () => {
      sortTracksByKey(th.dataset.sort, true);
    });
  });

  resultsEl.prepend(div);
  refreshGroupNavigation();
  const groupHeader = div.querySelector('.group-header');
  const updateGroupHeaderHeight = () => {
    updateGroupProgress(div, data.tracks);
    div.style.setProperty('--group-header-height', `${groupHeader.offsetHeight}px`);
  };
  updateGroupHeaderHeight();
  if (typeof ResizeObserver !== 'undefined') {
    div._headerResizeObserver = new ResizeObserver(updateGroupHeaderHeight);
    div._headerResizeObserver.observe(groupHeader);
  }
  hidePlayerBarIfNoTables();

  div.querySelector('.close-table-btn').addEventListener('click', () => {
    const wasPlayingThisGroup = activeTrack && activeTrack.folder === data.id;
    div._headerResizeObserver?.disconnect();
    div.remove();
    refreshGroupNavigation();

    const remainingTracks = getAllVisibleTracks();
    if (remainingTracks.length === 0) {
      stopXfadeLoop();
      cancelAnimationFrame(rafId);
      player.pause();
      player.removeAttribute('src');
      player.load();
      activeTrack = null;
      activeUrl = null;
      currentPeaks = null;
      playerBar.classList.add('hidden');
    } else if (wasPlayingThisGroup) {
      playTrack(remainingTracks[0].track);
    }
  });
  return true;
}

function downloadAllZip() {
  window.location.href = '/zip_all';
}

async function clearWorkspace() {
  await fetch('/clear', { method: 'POST' });
  resultsEl.querySelectorAll('.group').forEach(group => group._headerResizeObserver?.disconnect());
  resultsEl.innerHTML = '';
  refreshGroupNavigation();
  statusEl.textContent = 'Cleared output folder.';
  zipAllBtn.disabled = true;
  stopXfadeLoop();
  cancelAnimationFrame(rafId);
  player.pause();
  player.removeAttribute('src');
  player.load();
  activeTrack = null;
  activeUrl = null;
  currentPeaks = null;
  waveCache.clear();
  bufferCache.clear();
  playerBar.classList.add('hidden');
}

function hidePlayerBarIfNoTables() {
  const tables = resultsEl.querySelectorAll('.group');
  if (tables.length === 0) {
    playerBar.classList.add('hidden');
  }
}

function syncGoTopBtn() {
  goTopBtn?.classList.toggle('visible', window.scrollY > 240);
}

window.addEventListener('scroll', syncGoTopBtn, { passive: true });
goTopBtn?.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
syncGoTopBtn();

hidePlayerBarIfNoTables();
'use strict';

/* ==========================================================================
   Sound Finder
   マイクと端末センサーのみを使い、端末上だけで音源方向を推定する。
   音声データは一切ネットワークへ送信しない。録音ファイルも作成しない。
   ========================================================================== */

/* ---------------------------------------------------------------------- */
/* DOM references                                                          */
/* ---------------------------------------------------------------------- */

const el = {
  viewStart: document.getElementById('view-start'),
  viewMain: document.getElementById('view-main'),
  btnStart: document.getElementById('btn-start'),
  startError: document.getElementById('start-error'),

  statusBadge: document.getElementById('status-badge'),
  btnSettings: document.getElementById('btn-settings'),

  levelValue: document.getElementById('level-value'),
  levelFill: document.getElementById('level-fill'),

  freqValue: document.getElementById('freq-value'),
  spectrumCanvas: document.getElementById('spectrum-canvas'),
  btnLockFreq: document.getElementById('btn-lock-freq'),

  radarLabel: document.getElementById('radar-label'),
  headingValue: document.getElementById('heading-value'),
  radarCanvas: document.getElementById('radar-canvas'),
  scanInstruction: document.getElementById('scan-instruction'),

  resultReadout: document.getElementById('result-readout'),
  resultAngle: document.getElementById('result-angle'),
  resultConfidence: document.getElementById('result-confidence'),
  resultFreq: document.getElementById('result-freq'),
  resultLevel: document.getElementById('result-level'),

  proximityMessage: document.getElementById('proximity-message'),
  proximityGauge: document.getElementById('proximity-gauge'),
  proximityGaugeFill: document.getElementById('proximity-gauge-fill'),
  proximityGaugeLabel: document.getElementById('proximity-gauge-label'),
  modeNote: document.getElementById('mode-note'),

  historyCanvas: document.getElementById('history-canvas'),

  filterPanel: document.getElementById('filter-panel'),
  filterOptions: document.getElementById('filter-options'),
  customFilterInputs: document.getElementById('custom-filter-inputs'),
  customMin: document.getElementById('custom-min'),
  customMax: document.getElementById('custom-max'),
  lockBandwidth: document.getElementById('lock-bandwidth'),
  btnCloseFilter: document.getElementById('btn-close-filter'),

  actionHint: document.getElementById('action-hint'),
  btnPrimary: document.getElementById('btn-primary'),
  btnSecondary: document.getElementById('btn-secondary'),
};

/* ---------------------------------------------------------------------- */
/* Global state                                                            */
/* ---------------------------------------------------------------------- */

const state = {
  mode: 'idle', // idle | scanning | result | tracking

  // audio
  audioCtx: null,
  analyser: null,        // mono (downmixed) analyser for main level / spectrum
  analyserL: null,       // optional stereo left
  analyserR: null,       // optional stereo right
  isStereo: false,
  freqBinCount: 0,
  sampleRate: 44100,
  freqData: null,        // Uint8Array

  // filter band
  filterMode: 'full',
  customMin: 20,
  customMax: 20000,

  // frequency lock
  lockActive: false,
  lockedFreq: null,
  lockBandwidth: 50,

  // rolling measurements
  levelHistory: [],      // {t, level} last ~750ms for moving average
  displayLevel: 0,
  displayFreq: null,
  volumeLog: [],         // {t, level} last ~20s for the history graph

  // orientation
  orientationSource: 'none', // 'compass' | 'relative' | 'motion' | 'none'
  compassAvailable: false,
  rawHeadingCW: 0,        // continuous, not offset-adjusted (relative-mode bookkeeping)
  relativeOffset: null,
  currentHeading: 0,      // display heading, 0-360
  lastOrientationTime: 0,
  motionLastTime: 0,

  // scanning
  scanBuckets: null,      // array[36] of {sum, count, lastFreq}
  scanStartTime: 0,
  scanUnwrapped: 0,       // total unsigned angular travel (deg)
  scanLastHeadingForCoverage: null,
  scanRelativeBaselineSet: false,

  // result
  resultAngle: null,
  resultConfidenceLabel: null,
  resultFreq: null,
  resultLevel: null,
  resultBuckets: null,

  // tracking
  trackTargetAngle: null,
  trackSnapshots: [],     // periodic {t, level} for closer/farther comparison
  trackLastSnapshotTime: 0,
  trackMin: Infinity,
  trackMax: -Infinity,
  proximityRatio: 0,      // 0(遠い) 〜 1(かなり近い), tracking中のみ意味を持つ

  rafId: null,
};

const TWO_PI = Math.PI * 2;

/* ---------------------------------------------------------------------- */
/* Utility                                                                  */
/* ---------------------------------------------------------------------- */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function angleDiffSigned(a, b) {
  // shortest signed difference a-b in (-180, 180]
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function normalizeAngle(a) {
  return ((a % 360) + 360) % 360;
}

function setHidden(node, hidden) { node.hidden = hidden; }

/* ---------------------------------------------------------------------- */
/* Start flow: consent + permissions                                       */
/* ---------------------------------------------------------------------- */

el.btnStart.addEventListener('click', onStartPressed);

async function onStartPressed() {
  el.btnStart.disabled = true;
  el.startError.hidden = true;

  if (!window.isSecureContext) {
    showStartError('このアプリはHTTPS環境でのみ動作します。安全な接続でアクセスしてください。');
    el.btnStart.disabled = false;
    return;
  }

  // 1) 方向センサー権限（iOSはタップ直後でないと許可ダイアログが出ないため、
  //    他の権限要求より先に・同じユーザー操作の中で呼び出す）
  await initOrientation();

  // 2) マイク権限
  try {
    await initAudio();
  } catch (err) {
    el.btnStart.disabled = false;
    if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
      showStartError('マイクへのアクセスが許可されていません。iPhoneの設定からSafariのマイクアクセスを許可してください。');
    } else if (err && err.name === 'NotFoundError') {
      showStartError('マイクが見つかりませんでした。端末にマイクが接続されているか確認してください。');
    } else {
      showStartError('マイクの初期化に失敗しました。ページを再読み込みして、もう一度お試しください。');
    }
    return;
  }

  // 3) メイン画面へ
  el.viewStart.classList.remove('is-active');
  el.viewMain.classList.add('is-active');
  registerServiceWorker();
  startRenderLoop();
  setMode('idle');
}

function showStartError(msg) {
  el.startError.textContent = msg;
  el.startError.hidden = false;
}

/* ---------------------------------------------------------------------- */
/* Audio setup                                                             */
/* ---------------------------------------------------------------------- */

async function initAudio() {
  const constraints = {
    audio: {
      channelCount: { ideal: 2 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    // 一部端末はステレオ指定で失敗することがあるため、単純なモノラル要求で再試行
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioContextClass();
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (_) { /* noop */ }
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const trackSettings = stream.getAudioTracks()[0]?.getSettings?.() || {};
  const channelCount = trackSettings.channelCount || source.channelCount || 1;
  const isStereo = channelCount >= 2;

  // メイン解析用（常にモノラルへダウンミックスして扱う）
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.minDecibels = -95;
  analyser.maxDecibels = -10;
  analyser.smoothingTimeConstant = 0.35;
  analyser.channelCount = 1;
  analyser.channelCountMode = 'explicit';
  analyser.channelInterpretation = 'speakers';
  source.connect(analyser);

  state.audioCtx = audioCtx;
  state.analyser = analyser;
  state.freqBinCount = analyser.frequencyBinCount;
  state.freqData = new Uint8Array(state.freqBinCount);
  state.sampleRate = audioCtx.sampleRate;
  state.isStereo = isStereo;

  if (isStereo) {
    try {
      const splitter = audioCtx.createChannelSplitter(2);
      source.connect(splitter);
      const analyserL = audioCtx.createAnalyser();
      const analyserR = audioCtx.createAnalyser();
      [analyserL, analyserR].forEach((a) => {
        a.fftSize = 1024;
        a.smoothingTimeConstant = 0.5;
      });
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);
      state.analyserL = analyserL;
      state.analyserR = analyserR;
      state.timeDataL = new Float32Array(analyserL.fftSize);
      state.timeDataR = new Float32Array(analyserR.fftSize);
    } catch (e) {
      state.isStereo = false;
    }
  }

  updateModeNote();
}

/* ---------------------------------------------------------------------- */
/* Orientation setup                                                       */
/* ---------------------------------------------------------------------- */

async function initOrientation() {
  const DOE = window.DeviceOrientationEvent;
  const DME = window.DeviceMotionEvent;

  // 方位センサー権限。iOSではタップした瞬間の操作コンテキストの中で
  // 呼ばないとダイアログ自体が表示されないため、ここで即座に要求する。
  try {
    if (DOE && typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission();
      if (res === 'granted') {
        window.addEventListener('deviceorientation', handleOrientation, true);
      } else {
        state.orientationDenied = true;
      }
    } else if (DOE) {
      window.addEventListener('deviceorientation', handleOrientation, true);
    } else {
      state.orientationUnsupported = true;
    }
  } catch (_) {
    state.orientationDenied = true;
  }

  // モーションセンサー権限（コンパスが使えない場合のフォールバック用）も
  // 同じユーザー操作の中でまとめて要求しておく。後から要求すると
  // 操作コンテキストが失われ、ダイアログが出なくなるため。
  try {
    if (DME && typeof DME.requestPermission === 'function') {
      const res = await DME.requestPermission();
      if (res === 'granted') {
        window.addEventListener('devicemotion', handleMotionFallback, true);
      }
    } else if (DME) {
      window.addEventListener('devicemotion', handleMotionFallback, true);
    }
  } catch (_) { /* noop */ }

  // 数秒待っても deviceorientation が一度も来なければ、方向機能なし/
  // 相対モードとして扱う。
  setTimeout(() => {
    if (state.orientationSource === 'none') {
      updateModeNote();
      syncIdleAvailability();
    }
  }, 3000);
}

function handleOrientation(e) {
  let heading;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    state.compassAvailable = true;
    state.orientationSource = 'compass';
    heading = e.webkitCompassHeading;
  } else if (e.alpha != null) {
    const raw = (360 - e.alpha) % 360; // 反時計回りのalphaを時計回りへ変換
    if (state.relativeOffset === null) state.relativeOffset = raw;
    state.rawHeadingCW = raw;
    state.compassAvailable = !!e.absolute;
    state.orientationSource = e.absolute ? 'compass' : 'relative';
    heading = state.compassAvailable ? raw : normalizeAngle(raw - state.relativeOffset);
  } else {
    return;
  }

  state.currentHeading = normalizeAngle(heading);
  state.lastOrientationTime = performance.now();
  updateModeNote();
  syncIdleAvailability();
}

function handleMotionFallback(e) {
  if (state.orientationSource === 'compass' || state.orientationSource === 'relative') return;
  const rate = e.rotationRate && e.rotationRate.alpha; // deg/s（水平回転成分の近似）
  if (rate == null) return;
  const now = performance.now();
  if (!state.motionLastTime) { state.motionLastTime = now; return; }
  const dt = (now - state.motionLastTime) / 1000;
  state.motionLastTime = now;
  state.orientationSource = 'motion';
  state.currentHeading = normalizeAngle(state.currentHeading - rate * dt);
  state.lastOrientationTime = now;
  updateModeNote();
  syncIdleAvailability();
}

/* ---------------------------------------------------------------------- */
/* Mode / status                                                           */
/* ---------------------------------------------------------------------- */

function setMode(mode) {
  state.mode = mode;
  el.statusBadge.classList.remove('is-scanning', 'is-result', 'is-tracking');

  switch (mode) {
    case 'idle':
      el.statusBadge.textContent = '待機中';
      el.radarLabel.textContent = '現在方向';
      setHidden(el.scanInstruction, true);
      setHidden(el.resultReadout, true);
      setHidden(el.proximityMessage, true);
      el.proximityGauge.hidden = true;
      el.btnPrimary.textContent = '360°探索開始';
      el.btnPrimary.disabled = false;
      setHidden(el.btnSecondary, true);
      break;
    case 'scanning':
      el.statusBadge.textContent = '探索中';
      el.statusBadge.classList.add('is-scanning');
      el.radarLabel.textContent = '探索中';
      setHidden(el.scanInstruction, false);
      setHidden(el.resultReadout, true);
      setHidden(el.proximityMessage, true);
      el.proximityGauge.hidden = true;
      el.btnPrimary.textContent = '結果を見る';
      el.btnPrimary.disabled = false;
      el.btnSecondary.textContent = 'キャンセル';
      setHidden(el.btnSecondary, false);
      el.actionHint.textContent = '360°ゆっくり回転し、十分にまわったら「結果を見る」を押してください';
      break;
    case 'result':
      el.statusBadge.textContent = '結果';
      el.statusBadge.classList.add('is-result');
      el.radarLabel.textContent = '推定音源方向';
      setHidden(el.scanInstruction, true);
      setHidden(el.resultReadout, false);
      setHidden(el.proximityMessage, true);
      el.proximityGauge.hidden = true;
      el.btnPrimary.textContent = '音源を追跡';
      el.btnPrimary.disabled = false;
      el.btnSecondary.textContent = '再スキャン';
      setHidden(el.btnSecondary, false);
      el.actionHint.textContent = '推定方向はあくまで目安です。実際の位置とは異なる場合があります';
      break;
    case 'tracking':
      el.statusBadge.textContent = '追跡中';
      el.statusBadge.classList.add('is-tracking');
      el.radarLabel.textContent = '音源方向（追跡中）';
      setHidden(el.scanInstruction, true);
      setHidden(el.resultReadout, false);
      el.btnPrimary.textContent = '停止';
      el.btnPrimary.disabled = false;
      el.btnSecondary.textContent = '再スキャン';
      setHidden(el.btnSecondary, false);
      el.actionHint.textContent = '矢印が示す方向へゆっくり進んでください';
      break;
  }
  if (mode === 'idle') syncIdleAvailability();
  updateModeNote();
}

function syncIdleAvailability() {
  if (state.mode !== 'idle') return;
  el.actionHint.textContent = state.orientationSource === 'none'
    ? '方向センサーが利用できないため、360°探索は行えません（音量・周波数の計測は可能です）'
    : '端末を水平に持ち、周囲の音を計測できます';
  el.btnPrimary.disabled = state.orientationSource === 'none';
}

function updateModeNote() {
  const notes = [];
  if (state.orientationSource === 'relative') {
    notes.push('方向センサーが利用できないため、相対方向モードで動作しています。');
  } else if (state.orientationSource === 'motion') {
    notes.push('コンパスが利用できないため、モーションセンサーによる相対方向モードで動作しています。');
  } else if (state.orientationSource === 'none') {
    notes.push('方向センサーが利用できないため、相対方向モードで動作しています。');
  }
  if (state.isStereo) {
    const bal = state.stereoBalance;
    if (bal == null) {
      notes.push('ステレオ入力: 左右バランスを補助的に解析しています。');
    } else if (Math.abs(bal) < 0.08) {
      notes.push('ステレオ入力: 左右バランスは中央付近です。');
    } else {
      notes.push(`ステレオ入力: ${bal > 0 ? '右' : '左'}側がやや大きく聞こえています。`);
    }
  } else {
    notes.push('モノラル入力: 360°スキャン方式で方向を推定します。');
  }
  el.modeNote.textContent = notes.join(' ');
  el.modeNote.hidden = false;
}

function computeStereoBalance() {
  if (!state.isStereo || !state.analyserL || !state.analyserR) return null;
  state.analyserL.getFloatTimeDomainData(state.timeDataL);
  state.analyserR.getFloatTimeDomainData(state.timeDataR);
  const rms = (arr) => {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    return Math.sqrt(s / arr.length);
  };
  const rL = rms(state.timeDataL);
  const rR = rms(state.timeDataR);
  const total = rL + rR;
  if (total < 1e-5) return 0;
  return (rR - rL) / total; // -1..1, 負=左が大きい, 正=右が大きい
}

/* ---------------------------------------------------------------------- */
/* Filter band UI                                                          */
/* ---------------------------------------------------------------------- */

const FILTER_RANGES = {
  full: [20, 20000],
  low: [20, 250],
  mid: [250, 2000],
  high: [2000, 10000],
};

el.btnSettings.addEventListener('click', () => {
  el.filterPanel.hidden = !el.filterPanel.hidden;
});
el.btnCloseFilter.addEventListener('click', () => { el.filterPanel.hidden = true; });

el.filterOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  [...el.filterOptions.children].forEach((c) => c.classList.remove('is-active'));
  btn.classList.add('is-active');
  state.filterMode = btn.dataset.filter;
  el.customFilterInputs.hidden = state.filterMode !== 'custom';
});

el.customMin.addEventListener('input', () => {
  state.customMin = clamp(parseInt(el.customMin.value, 10) || 20, 20, 20000);
});
el.customMax.addEventListener('input', () => {
  state.customMax = clamp(parseInt(el.customMax.value, 10) || 20000, 20, 20000);
});
el.lockBandwidth.addEventListener('input', () => {
  state.lockBandwidth = clamp(parseInt(el.lockBandwidth.value, 10) || 50, 5, 500);
});

function getFilterRange() {
  if (state.filterMode === 'custom') {
    return [Math.min(state.customMin, state.customMax), Math.max(state.customMin, state.customMax)];
  }
  return FILTER_RANGES[state.filterMode] || FILTER_RANGES.full;
}

function getEffectiveRange() {
  if (state.lockActive && state.lockedFreq != null) {
    const bw = state.lockBandwidth;
    return [clamp(state.lockedFreq - bw, 20, 20000), clamp(state.lockedFreq + bw, 20, 20000)];
  }
  return getFilterRange();
}

/* ---------------------------------------------------------------------- */
/* Frequency lock                                                          */
/* ---------------------------------------------------------------------- */

el.btnLockFreq.addEventListener('click', () => {
  if (state.lockActive) {
    state.lockActive = false;
    state.lockedFreq = null;
    el.btnLockFreq.textContent = 'この周波数を追跡';
    el.btnLockFreq.classList.remove('is-active');
  } else if (state.displayFreq != null) {
    state.lockActive = true;
    state.lockedFreq = Math.round(state.displayFreq);
    el.btnLockFreq.textContent = `追跡解除（${state.lockedFreq}Hz ±${state.lockBandwidth}Hz）`;
    el.btnLockFreq.classList.add('is-active');
  }
});

/* ---------------------------------------------------------------------- */
/* Action bar                                                              */
/* ---------------------------------------------------------------------- */

el.btnPrimary.addEventListener('click', () => {
  if (state.mode === 'idle') startScan();
  else if (state.mode === 'scanning') finishScan();
  else if (state.mode === 'result') startTracking();
  else if (state.mode === 'tracking') { setMode('result'); }
});

el.btnSecondary.addEventListener('click', () => {
  if (state.mode === 'scanning') cancelScan();
  else if (state.mode === 'result' || state.mode === 'tracking') startScan();
});

/* ---------------------------------------------------------------------- */
/* 360° scan                                                               */
/* ---------------------------------------------------------------------- */

const SCAN_TIMEOUT_MS = 45000;
const SCAN_MIN_COVERAGE = 0.7; // 36分割の70%が埋まれば十分とみなす

function startScan() {
  state.scanBuckets = new Array(36).fill(null).map(() => ({ sum: 0, count: 0, freqSum: 0 }));
  state.scanStartTime = performance.now();
  state.scanLastHeadingForCoverage = null;
  if (state.orientationSource === 'relative') {
    // 「探索開始時の向きを0°」とする
    state.relativeOffset = state.rawHeadingCW;
    state.currentHeading = 0;
  } else if (state.orientationSource === 'motion') {
    state.currentHeading = 0;
  }
  setMode('scanning');
}

function cancelScan() {
  setMode('idle');
}

function recordScanSample() {
  const bucketIdx = Math.round(normalizeAngle(state.currentHeading) / 10) % 36;
  const bucket = state.scanBuckets[bucketIdx];
  bucket.sum += state.displayLevel;
  bucket.count += 1;
  if (state.displayFreq != null) bucket.freqSum += state.displayFreq;

  const elapsed = performance.now() - state.scanStartTime;
  const filled = state.scanBuckets.filter((b) => b.count > 0).length;
  if (elapsed > 3000 && filled / 36 >= SCAN_MIN_COVERAGE) {
    // 十分な被覆があれば自動終了を促す（強制はしない。ユーザーが決定づける）
  }
  if (elapsed > SCAN_TIMEOUT_MS) finishScan();
}

function finishScan() {
  const buckets = state.scanBuckets;
  const filledCount = buckets.filter((b) => b.count > 0).length;
  if (filledCount < 4) {
    // データが少なすぎる場合は続行を促す
    el.actionHint.textContent = 'データが不足しています。もう少し回転させてください';
    return;
  }

  // 各バケットの平均レベルを算出し、欠損は円環補間で埋める
  const levels = buckets.map((b) => (b.count > 0 ? b.sum / b.count : null));
  const freqs = buckets.map((b) => (b.count > 0 ? b.freqSum / b.count : null));
  const filledLevels = interpolateCircular(levels);
  const filledFreqs = interpolateCircular(freqs);

  // ピーク方向の検出
  let peakIdx = 0;
  for (let i = 1; i < 36; i++) if (filledLevels[i] > filledLevels[peakIdx]) peakIdx = i;

  // 放物線補間でピーク角度を10°より細かく推定
  const prev = filledLevels[(peakIdx + 35) % 36];
  const curr = filledLevels[peakIdx];
  const next = filledLevels[(peakIdx + 1) % 36];
  let refineDeg = 0;
  const denom = (prev - 2 * curr + next);
  if (Math.abs(denom) > 1e-6) {
    refineDeg = clamp(0.5 * (prev - next) / denom, -1, 1) * 10;
  }
  const refinedAngle = normalizeAngle(peakIdx * 10 + refineDeg);

  // 信頼度判定：ピークと隣接方向（±10°）との差
  const neighborAvg = (filledLevels[(peakIdx + 35) % 36] + filledLevels[(peakIdx + 1) % 36]) / 2;
  const diff = curr - neighborAvg;
  const range = Math.max(...filledLevels) - Math.min(...filledLevels);
  let confidence = 'low';
  if (range >= 5) {
    if (diff >= 12) confidence = 'high';
    else if (diff >= 4) confidence = 'mid';
  }

  state.resultAngle = refinedAngle;
  state.resultConfidenceLabel = confidence;
  state.resultFreq = filledFreqs[peakIdx] != null ? Math.round(filledFreqs[peakIdx]) : state.displayFreq;
  state.resultLevel = Math.round(curr);
  state.resultBuckets = filledLevels;

  el.resultAngle.textContent = `${Math.round(refinedAngle)}°`;
  el.resultConfidence.textContent = { high: '高', mid: '中', low: '低' }[confidence];
  el.resultConfidence.className = `confidence-pill ${confidence}`;
  el.resultFreq.textContent = `${state.resultFreq} Hz`;
  el.resultLevel.textContent = `${state.resultLevel}`;

  state.trackSnapshots = [];
  setMode('result');
}

function interpolateCircular(arr) {
  const n = arr.length;
  const out = arr.slice();
  const knownIdx = [];
  for (let i = 0; i < n; i++) if (out[i] != null) knownIdx.push(i);
  if (knownIdx.length === 0) return out.fill(0);
  for (let i = 0; i < n; i++) {
    if (out[i] != null) continue;
    // 直近の既知点（前方・後方、円環）を探して線形補間
    let before = null, after = null, distBefore = 0, distAfter = 0;
    for (let d = 1; d <= n; d++) {
      const bi = (i - d + n) % n;
      if (out[bi] != null) { before = out[bi]; distBefore = d; break; }
    }
    for (let d = 1; d <= n; d++) {
      const ai = (i + d) % n;
      if (out[ai] != null) { after = out[ai]; distAfter = d; break; }
    }
    if (before != null && after != null) {
      const t = distBefore / (distBefore + distAfter);
      out[i] = before + (after - before) * t;
    } else {
      out[i] = before != null ? before : after != null ? after : 0;
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Tracking                                                                 */
/* ---------------------------------------------------------------------- */

function startTracking() {
  state.trackTargetAngle = state.resultAngle;
  if (state.resultFreq != null) {
    state.lockActive = true;
    state.lockedFreq = state.resultFreq;
    el.btnLockFreq.textContent = `追跡解除（${state.lockedFreq}Hz ±${state.lockBandwidth}Hz）`;
    el.btnLockFreq.classList.add('is-active');
  }
  state.trackSnapshots = [{ t: performance.now(), level: state.displayLevel }];
  state.trackLastSnapshotTime = performance.now();
  state.trackMin = state.displayLevel;
  state.trackMax = state.displayLevel;
  state.proximityRatio = 0;
  el.proximityGauge.hidden = false;
  setMode('tracking');
}

function updateProximityGauge() {
  const level = state.displayLevel;
  state.trackMin = Math.min(state.trackMin, level);
  state.trackMax = Math.max(state.trackMax, level);
  const range = state.trackMax - state.trackMin;

  if (range < 3) {
    state.proximityRatio = 0;
    el.proximityGaugeFill.style.width = '6%';
    el.proximityGaugeFill.style.animationDuration = '1.8s';
    el.proximityGaugeLabel.textContent = '計測中';
    el.proximityGaugeLabel.className = 'proximity-gauge-label';
    return;
  }

  const ratio = clamp((level - state.trackMin) / range, 0, 1);
  state.proximityRatio = ratio;

  el.proximityGaugeFill.style.width = `${6 + ratio * 94}%`;
  // 近づくほど点滅を速く（1.8秒 → 0.35秒）
  const duration = 1.8 - ratio * 1.45;
  el.proximityGaugeFill.style.animationDuration = `${duration.toFixed(2)}s`;

  let label, cls;
  if (ratio < 0.3) { label = '遠い'; cls = 'cold'; }
  else if (ratio < 0.6) { label = '接近中'; cls = 'warm'; }
  else if (ratio < 0.85) { label = 'かなり近い'; cls = 'hot'; }
  else { label = '目の前かも'; cls = 'hot'; }
  el.proximityGaugeLabel.textContent = label;
  el.proximityGaugeLabel.className = `proximity-gauge-label ${cls}`;
}

function updateProximity() {
  const now = performance.now();
  if (now - state.trackLastSnapshotTime < 2000) return;
  state.trackLastSnapshotTime = now;
  state.trackSnapshots.push({ t: now, level: state.displayLevel });
  if (state.trackSnapshots.length > 6) state.trackSnapshots.shift();
  if (state.trackSnapshots.length < 2) return;

  const prevLevel = state.trackSnapshots[state.trackSnapshots.length - 2].level;
  const currLevel = state.trackSnapshots[state.trackSnapshots.length - 1].level;
  const delta = currLevel - prevLevel;

  el.proximityMessage.hidden = false;
  if (delta >= 4) {
    el.proximityMessage.textContent = `音源に近づいている可能性があります（${Math.round(prevLevel)} → ${Math.round(currLevel)}）`;
    el.proximityMessage.className = 'proximity-message closer';
  } else if (delta <= -4) {
    el.proximityMessage.textContent = `音源から離れている可能性があります（${Math.round(prevLevel)} → ${Math.round(currLevel)}）`;
    el.proximityMessage.className = 'proximity-message farther';
  } else {
    el.proximityMessage.textContent = '音量に大きな変化はありません';
    el.proximityMessage.className = 'proximity-message';
  }
}

/* ---------------------------------------------------------------------- */
/* Canvas sizing                                                           */
/* ---------------------------------------------------------------------- */

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

/* ---------------------------------------------------------------------- */
/* Rendering: spectrum                                                     */
/* ---------------------------------------------------------------------- */

function drawSpectrum() {
  const { w, h } = fitCanvas(el.spectrumCanvas);
  const ctx = el.spectrumCanvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const data = state.freqData;
  const nyquist = state.sampleRate / 2;
  const binHz = state.sampleRate / (2 * state.freqBinCount);
  const [loHz, hiHz] = getFilterRange();
  const minF = 20, maxF = Math.min(20000, nyquist);
  const logMin = Math.log10(minF), logMax = Math.log10(maxF);

  const barCount = Math.min(96, w);
  const barW = w / barCount;

  for (let i = 0; i < barCount; i++) {
    const t0 = i / barCount, t1 = (i + 1) / barCount;
    const f0 = Math.pow(10, logMin + (logMax - logMin) * t0);
    const f1 = Math.pow(10, logMin + (logMax - logMin) * t1);
    const bin0 = clamp(Math.floor(f0 / binHz), 0, data.length - 1);
    const bin1 = clamp(Math.ceil(f1 / binHz), bin0 + 1, data.length);
    let maxV = 0;
    for (let b = bin0; b < bin1; b++) if (data[b] > maxV) maxV = data[b];
    const inBand = f1 >= loHz && f0 <= hiHz;
    const barH = (maxV / 255) * h;
    ctx.fillStyle = inBand ? 'rgba(94, 234, 212, 0.9)' : 'rgba(94, 234, 212, 0.22)';
    ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH);
  }
}

/* ---------------------------------------------------------------------- */
/* Rendering: volume history                                               */
/* ---------------------------------------------------------------------- */

function drawHistory() {
  const { w, h } = fitCanvas(el.historyCanvas);
  const ctx = el.historyCanvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const now = performance.now();
  const windowMs = 20000;
  state.volumeLog = state.volumeLog.filter((p) => now - p.t <= windowMs);

  ctx.strokeStyle = 'rgba(94, 234, 212, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  state.volumeLog.forEach((p, i) => {
    const x = w - ((now - p.t) / windowMs) * w;
    const y = h - (p.level / 100) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // baseline
  ctx.strokeStyle = 'rgba(133, 160, 158, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 1);
  ctx.lineTo(w, h - 1);
  ctx.stroke();
}

/* ---------------------------------------------------------------------- */
/* Rendering: radar                                                        */
/* ---------------------------------------------------------------------- */

function polar(cx, cy, r, bearingFromUp) {
  const a = (bearingFromUp * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function drawRadar() {
  const { w, h } = fitCanvas(el.radarCanvas);
  const ctx = el.radarCanvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2 - Math.min(w, h) * 0.08;
  const heading = state.currentHeading;

  // 目盛りリング
  ctx.strokeStyle = 'rgba(35, 48, 47, 0.9)';
  ctx.lineWidth = Math.max(1, R * 0.006);
  [1, 0.66, 0.33].forEach((f) => {
    ctx.beginPath();
    ctx.arc(cx, cy, R * f, 0, TWO_PI);
    ctx.stroke();
  });

  // 30°ごとの目盛り（現在方位を上にして回転）
  ctx.strokeStyle = 'rgba(35, 48, 47, 0.9)';
  for (let deg = 0; deg < 360; deg += 30) {
    const screenAngle = deg - heading;
    const [x1, y1] = polar(cx, cy, R, screenAngle);
    const [x2, y2] = polar(cx, cy, R * 0.92, screenAngle);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  if (state.compassAvailable) {
    ctx.fillStyle = 'rgba(133, 160, 158, 0.9)';
    ctx.font = `${Math.round(R * 0.11)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labels = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
    labels.forEach(([label, deg]) => {
      const [x, y] = polar(cx, cy, R * 0.8, deg - heading);
      ctx.fillText(label, x, y);
    });
  }

  // 音量ヒートマップ（scanning中は途中経過、result/tracking中は確定結果）
  const buckets = state.mode === 'scanning'
    ? scanSnapshotForDraw()
    : (state.mode === 'result' || state.mode === 'tracking') ? state.resultBuckets : null;

  if (buckets) {
    const maxLevel = Math.max(10, ...buckets);
    ctx.beginPath();
    for (let i = 0; i <= 36; i++) {
      const idx = i % 36;
      const level = buckets[idx] || 0;
      const r = R * 0.18 + (level / maxLevel) * R * 0.72;
      const screenAngle = idx * 10 - heading;
      const [x, y] = polar(cx, cy, r, screenAngle);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(94, 234, 212, 0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.75)';
    ctx.lineWidth = Math.max(1.5, R * 0.01);
    ctx.stroke();
  }

  // 中心（現在地）
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.045, 0, TWO_PI);
  ctx.fillStyle = '#5eead4';
  ctx.shadowColor = 'rgba(94, 234, 212, 0.7)';
  ctx.shadowBlur = R * 0.08;
  ctx.fill();
  ctx.shadowBlur = 0;

  // 現在の向き（常に上向き固定の三角形）
  ctx.beginPath();
  const [tx, ty] = polar(cx, cy, R * 1.0, 0);
  const [lx, ly] = polar(cx, cy, R * 0.9, -8);
  const [rx, ry] = polar(cx, cy, R * 0.9, 8);
  ctx.moveTo(tx, ty);
  ctx.lineTo(lx, ly);
  ctx.lineTo(rx, ry);
  ctx.closePath();
  ctx.fillStyle = '#5eead4';
  ctx.fill();

  // 推定音源方向 / 追跡目標
  const targetBearing = state.mode === 'tracking' ? state.trackTargetAngle
    : (state.mode === 'result' ? state.resultAngle : null);

  if (targetBearing != null) {
    const screenAngle = targetBearing - heading;
    const [mx, my] = polar(cx, cy, R * 0.98, screenAngle);

    let dotR = R * 0.055;
    let glowBlur = R * 0.08;
    let dotColor = '#ff6b5e';
    if (state.mode === 'tracking') {
      const ratio = state.proximityRatio || 0;
      const period = 1800 - ratio * 1450; // ms、近いほど速く点滅
      const phase = (performance.now() % period) / period;
      const pulse = 0.5 + 0.5 * Math.sin(phase * TWO_PI);
      dotR = R * (0.05 + 0.035 * ratio * pulse);
      glowBlur = R * (0.06 + 0.14 * ratio * pulse);
    }

    ctx.beginPath();
    ctx.arc(mx, my, dotR, 0, TWO_PI);
    ctx.fillStyle = dotColor;
    ctx.shadowColor = 'rgba(255, 107, 94, 0.65)';
    ctx.shadowBlur = glowBlur;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (state.mode === 'tracking') {
      // 中心から目標方向への矢印
      const [ax, ay] = polar(cx, cy, R * 0.62, screenAngle);
      ctx.strokeStyle = '#ff6b5e';
      ctx.lineWidth = Math.max(2, R * 0.018);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ax, ay);
      ctx.stroke();
      const headA = screenAngle;
      const [h1x, h1y] = polar(cx, cy, R * 0.62 - R * 0.09, headA - 14);
      const [h2x, h2y] = polar(cx, cy, R * 0.62 - R * 0.09, headA + 14);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(h1x, h1y);
      ctx.lineTo(h2x, h2y);
      ctx.closePath();
      ctx.fillStyle = '#ff6b5e';
      ctx.fill();
    }
  }
}

function scanSnapshotForDraw() {
  if (!state.scanBuckets) return null;
  return state.scanBuckets.map((b) => (b.count > 0 ? b.sum / b.count : 0));
}

/* ---------------------------------------------------------------------- */
/* Main render / analysis loop                                             */
/* ---------------------------------------------------------------------- */

function analyzeFrame() {
  const analyser = state.analyser;
  if (!analyser) return;
  analyser.getByteFrequencyData(state.freqData);

  const binHz = state.sampleRate / (2 * state.freqBinCount);
  const [loHz, hiHz] = getEffectiveRange();
  const loBin = clamp(Math.floor(loHz / binHz), 0, state.freqBinCount - 1);
  const hiBin = clamp(Math.ceil(hiHz / binHz), loBin + 1, state.freqBinCount);

  let sum = 0, peakVal = -1, peakBin = loBin;
  for (let i = loBin; i < hiBin; i++) {
    const v = state.freqData[i];
    sum += v;
    if (v > peakVal) { peakVal = v; peakBin = i; }
  }
  const avg = sum / (hiBin - loBin);
  const instLevel = clamp((avg / 255) * 100, 0, 100);

  const now = performance.now();
  state.levelHistory.push({ t: now, level: instLevel });
  state.levelHistory = state.levelHistory.filter((p) => now - p.t <= 750);
  const smoothed = state.levelHistory.reduce((a, p) => a + p.level, 0) / state.levelHistory.length;
  state.displayLevel = smoothed;

  const rawFreq = peakBin * binHz;
  state.displayFreq = state.displayFreq == null ? rawFreq : state.displayFreq * 0.7 + rawFreq * 0.3;

  state.volumeLog.push({ t: now, level: smoothed });

  // UI テキスト更新
  el.levelValue.textContent = Math.round(smoothed);
  el.levelFill.style.width = `${smoothed}%`;
  el.freqValue.textContent = peakVal > 4 ? Math.round(state.displayFreq) : '–';
  el.headingValue.textContent = Math.round(normalizeAngle(state.currentHeading));

  if (state.isStereo) {
    state.stereoBalance = computeStereoBalance();
    state.stereoNoteTick = (state.stereoNoteTick || 0) + 1;
    if (state.stereoNoteTick % 20 === 0) updateModeNote();
  }
}

function renderLoop() {
  analyzeFrame();
  drawSpectrum();
  drawHistory();
  drawRadar();

  if (state.mode === 'scanning') {
    recordScanSample();
  }
  if (state.mode === 'tracking') {
    updateProximity();
    updateProximityGauge();
  }

  state.rafId = requestAnimationFrame(renderLoop);
}

function startRenderLoop() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  renderLoop();
}

window.addEventListener('resize', () => {
  fitCanvas(el.spectrumCanvas);
  fitCanvas(el.historyCanvas);
  fitCanvas(el.radarCanvas);
});

/* ---------------------------------------------------------------------- */
/* Service worker (PWA / offline shell)                                    */
/* ---------------------------------------------------------------------- */

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => { /* noop */ });
  }
}

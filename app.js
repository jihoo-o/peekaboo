// Peekaboo AR — 물체 뒤 캐릭터. 단계 번호(S1, S2, ...)는 각 코드가 추가된 단계다.
// S1: 카메라 + MediaPipe ObjectDetector 루프 + 디버그 오버레이
// S2: 타깃 락(가장 큰 허용 클래스 → IoU 매칭) + One Euro 필터 스무딩
// S3: 2D 캔버스 캐릭터 등장(peek/idle/hide) + bbox 사각형 오클루전
// S4: InteractiveSegmenter(MagicTouch) 마스크 오클루전 (EMA + 블러, bbox IoU 게이트)
// S5: 탭 → wave, 셔터 → 공유/저장, 안내 문구

const VISION_VERSION = '0.10.35';
const VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const SEGMENTER_MODEL = 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite';
const DETECTOR_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

// S2: 락 대상 클래스
const ALLOWED = ['cup', 'bottle', 'book', 'bowl', 'vase', 'potted plant', 'mouse', 'laptop'];
const LOCK_MIN_SCORE = 0.5;
const LOCK_MIN_IOU = 0.3;
const LOCK_LOST_MS = 1000;

// S4: 마스크 설정
const SEG_INTERVAL_MS = 100;
const MASK_EMA = 0.5;         // 깜빡임 심하면 0.7(prev)/0.3(new)
const MASK_MIN_IOU = 0.2;     // 마스크-bbox IoU가 이보다 낮으면 그 마스크는 버림
const MASK_BLUR_PX = 2;

const params = new URLSearchParams(location.search);
const USE_MASK = params.get('mask') !== '0';
const RES = params.get('res') === '480' ? { width: { ideal: 640 }, height: { ideal: 480 } }
                                         : { width: { ideal: 1280 }, height: { ideal: 720 } };

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const msg = document.getElementById('msg');
const startBtn = document.getElementById('start');

// ---- 상태 (디버그용으로 window에도 노출) ----
const state = {
  detections: [],      // 마지막 프레임의 원본 검출 결과
  detTimes: [],        // 최근 1초 검출 타임스탬프
  frameTimes: [],      // 최근 1초 렌더 타임스탬프
  delegate: '-',
  error: null,
  // S2
  lock: null,          // { label, raw:{x,y,w,h}, box:{x,y,w,h}(스무딩), lastSeen }
  missMs: 0,
  // S3
  char: { state: 'hidden', since: 0, progress: 0 }, // hidden → peek → idle → hide
  // S4
  segTimes: [], segBusy: false, lastSegAt: 0,
  mask: null,          // { w, h, alpha: Float32Array } EMA 마스크 (비디오 해상도)
  maskRejects: 0,
  // S5
  shots: 0,
};
window.__peekaboo = state;

// ---- 유틸 ----
function hz(times, now) {
  while (times.length && now - times[0] > 1000) times.shift();
  return times.length;
}

// ---- S2: One Euro Filter (Casiez et al., CHI 2012) ----
class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = null;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max((t - this.t) / 1000, 1e-3); this.t = t;
    const dxRaw = (x - this.x) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    this.dx = aD * dxRaw + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuro.alpha(cutoff, dt);
    this.x = a * x + (1 - a) * this.x;
    return this.x;
  }
}

// ---- S2: 타깃 락 트래커 ----
function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

function makeFilters() {
  return { x: new OneEuro(), y: new OneEuro(), w: new OneEuro(), h: new OneEuro() };
}

function updateTracker(dets, now) {
  const lock = state.lock;
  if (!lock) {
    // 락 없음: 허용 클래스 중 score>=0.5, 면적 최대
    let best = null;
    for (const d of dets) {
      if (!ALLOWED.includes(d.label) || d.score < LOCK_MIN_SCORE) continue;
      if (!best || d.w * d.h > best.w * best.h) best = d;
    }
    if (best) {
      const f = makeFilters();
      state.lock = {
        label: best.label, raw: { ...best }, filters: f, lastSeen: now,
        box: { x: f.x.filter(best.x, now), y: f.y.filter(best.y, now), w: f.w.filter(best.w, now), h: f.h.filter(best.h, now) },
      };
      state.missMs = 0;
    }
    return;
  }
  // 락 상태: IoU 최대(>=0.3) 검출로 갱신
  let best = null, bestIou = LOCK_MIN_IOU;
  for (const d of dets) {
    const v = iou(lock.raw, d);
    if (v >= bestIou) { best = d; bestIou = v; }
  }
  if (best) {
    lock.raw = { ...best }; lock.label = best.label; lock.lastSeen = now;
    const f = lock.filters;
    lock.box = { x: f.x.filter(best.x, now), y: f.y.filter(best.y, now), w: f.w.filter(best.w, now), h: f.h.filter(best.h, now) };
    state.missMs = 0;
  } else {
    state.missMs = now - lock.lastSeen;
    if (state.missMs >= LOCK_LOST_MS) { state.lock = null; state.missMs = 0; }
  }
}

// video는 object-fit: cover로 표시된다. videoWidth/Height → 화면(canvas) 좌표 변환.
function coverTransform() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = canvas.width, ch = canvas.height;
  const s = Math.max(cw / vw, ch / vh);
  return { s, ox: (cw - vw * s) / 2, oy: (ch - vh * s) / 2, vw, vh };
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}
window.addEventListener('resize', resizeCanvas);

// ---- 카메라 ----
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', ...RES }, audio: false,
  });
  video.srcObject = stream;
  await new Promise((r) => (video.onloadedmetadata = r));
  await video.play();
  video.style.visibility = 'hidden'; // S3: 캔버스가 보이는 화면
}

// ---- 검출기 ----
let detector = null;
async function createDetector() {
  const { FilesetResolver, ObjectDetector, InteractiveSegmenter } = await import(`${VISION_CDN}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: DETECTOR_MODEL, delegate },
    runningMode: 'VIDEO', scoreThreshold: 0.4, maxResults: 5,
  });
  try {
    detector = await ObjectDetector.createFromOptions(fileset, opts('GPU'));
    state.delegate = 'GPU';
  } catch (e) {
    console.warn('GPU delegate failed, falling back to CPU', e);
    detector = await ObjectDetector.createFromOptions(fileset, opts('CPU'));
    state.delegate = 'CPU';
  }
  visionModule = { InteractiveSegmenter, fileset }; // S4
}

// ---- 검출 루프 (requestVideoFrameCallback) ----
let lastVideoTime = -1;
function onVideoFrame(now) {
  if (detector && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = detector.detectForVideo(video, performance.now());
    state.detections = result.detections.map((d) => ({
      x: d.boundingBox.originX, y: d.boundingBox.originY,
      w: d.boundingBox.width, h: d.boundingBox.height,
      label: d.categories[0]?.categoryName ?? '?', score: d.categories[0]?.score ?? 0,
    }));
    state.detTimes.push(performance.now());
    updateTracker(state.detections, performance.now()); // S2
  }
  maybeSegment(performance.now()); // S4
  video.requestVideoFrameCallback(onVideoFrame);
}

// ---- S4: 세그멘테이션 마스크 ----
let segmenter = null;
let visionModule = null; // S4: createDetector에서 채움
async function createSegmenter() {
  if (!USE_MASK) return;
  const { InteractiveSegmenter, fileset } = visionModule;
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate },
    outputCategoryMask: true, outputConfidenceMasks: false,
  });
  try { segmenter = await InteractiveSegmenter.createFromOptions(fileset, opts('GPU')); }
  catch (e) { console.warn('segmenter GPU failed, CPU fallback', e); segmenter = await InteractiveSegmenter.createFromOptions(fileset, opts('CPU')); }
}

const maskCanvas = document.createElement('canvas'); // 비디오 해상도, 알파 = 마스크
const maskCtx = maskCanvas.getContext('2d');
const clipCanvas = document.createElement('canvas'); // video를 마스크로 클리핑한 결과
const clipCtx = clipCanvas.getContext('2d');

// 락 상태일 때만 100ms 간격으로 bbox 중심점 프롬프트 세그멘테이션
function maybeSegment(now) {
  if (!segmenter || !state.lock || state.segBusy || now - state.lastSegAt < SEG_INTERVAL_MS) return;
  const b = state.lock.box, vw = video.videoWidth, vh = video.videoHeight;
  const kx = (b.x + b.w / 2) / vw, ky = (b.y + b.h / 2) / vh;
  if (!(kx > 0 && kx < 1 && ky > 0 && ky < 1)) return;
  state.segBusy = true; state.lastSegAt = now;
  const box = { ...b };
  try {
    segmenter.segment(video, { keypoint: { x: kx, y: ky } }, (result) => {
      try { ingestMask(result.categoryMask, box); } finally { state.segBusy = false; }
    });
  } catch (e) { console.warn('segment failed', e); state.segBusy = false; }
}

// 카테고리 마스크 → 알파 EMA. bbox와 IoU < 0.2면 버림.
// MagicTouch 카테고리 마스크는 선택 물체=0, 배경=255로 온다(실측). 혹시 반대여도 되도록 bbox와 더 잘 맞는 극성을 고른다.
function ingestMask(mpMask, box) {
  if (!mpMask) return;
  const w = mpMask.width, h = mpMask.height;
  const data = mpMask.getAsUint8Array();
  const sx = w / video.videoWidth, sy = h / video.videoHeight;
  const bx0 = box.x * sx, by0 = box.y * sy, bx1 = (box.x + box.w) * sx, by1 = (box.y + box.h) * sy;
  let zero = 0, zeroIn = 0, nz = 0, nzIn = 0;
  for (let y = 0; y < h; y++) {
    const inY = y >= by0 && y < by1;
    for (let x = 0; x < w; x++) {
      const inBox = inY && x >= bx0 && x < bx1;
      if (data[y * w + x]) { nz++; if (inBox) nzIn++; } else { zero++; if (inBox) zeroIn++; }
    }
  }
  const boxArea = (bx1 - bx0) * (by1 - by0);
  const iouZero = zeroIn / (zero + boxArea - zeroIn || 1);
  const iouNz = nzIn / (nz + boxArea - nzIn || 1);
  const fgIsZero = iouZero >= iouNz;
  if (Math.max(iouZero, iouNz) < MASK_MIN_IOU) { state.maskRejects++; return; }

  if (!state.mask || state.mask.w !== w || state.mask.h !== h) {
    state.mask = { w, h, alpha: new Float32Array(w * h) };
    maskCanvas.width = w; maskCanvas.height = h;
  }
  const a = state.mask.alpha;
  for (let i = 0; i < a.length; i++) {
    const fg = fgIsZero ? (data[i] === 0 ? 1 : 0) : (data[i] ? 1 : 0);
    a[i] = MASK_EMA * a[i] + (1 - MASK_EMA) * fg;
  }
  // 알파 채널로 굽기
  const img = maskCtx.createImageData(w, h);
  const px = img.data;
  for (let i = 0; i < a.length; i++) px[i * 4 + 3] = a[i] * 255;
  maskCtx.putImageData(img, 0, 0);
  state.segTimes.push(performance.now());
}

// (3) video를 마스크로 클리핑해 캐릭터 위에 덮기. 마스크가 없으면 false → 사각형 폴백.
function occludeWithMask(s, ox, oy, vw, vh) {
  if (!state.mask) return false;
  if (clipCanvas.width !== vw || clipCanvas.height !== vh) { clipCanvas.width = vw; clipCanvas.height = vh; }
  clipCtx.globalCompositeOperation = 'source-over';
  clipCtx.filter = 'none';
  clipCtx.clearRect(0, 0, vw, vh);
  clipCtx.drawImage(video, 0, 0, vw, vh);
  clipCtx.globalCompositeOperation = 'destination-in';
  clipCtx.filter = `blur(${MASK_BLUR_PX}px)`;
  clipCtx.drawImage(maskCanvas, 0, 0, vw, vh);
  clipCtx.filter = 'none';
  clipCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(clipCanvas, ox, oy, vw * s, vh * s);
  return true;
}

// ---- S3: 캐릭터 ----
const PEEK_MS = 600, HIDE_MS = 300, WAVE_MS = 800; // S5: wave
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

// 락 여부에 따라 상태 전이. progress 0=숨김(bbox.y+0.6h), 1=완전 등장(bbox.y+0.15h)
function updateCharacter(now) {
  const c = state.char;
  const locked = !!state.lock;
  if (locked && (c.state === 'hidden' || c.state === 'hide')) { c.state = 'peek'; c.since = now; }
  if (!locked && (c.state === 'peek' || c.state === 'idle' || c.state === 'wave')) { c.state = 'hide'; c.since = now; }
  const el = now - c.since;
  switch (c.state) {
    case 'peek':
      c.progress = easeOutBack(Math.min(el / PEEK_MS, 1));
      if (el >= PEEK_MS) { c.state = 'idle'; c.since = now; c.progress = 1; }
      break;
    case 'idle': c.progress = 1; break;
    case 'wave': // S5: 0.8초 동안 팔 흔들기 + 살짝 점프
      c.progress = 1;
      if (el >= WAVE_MS) { c.state = 'idle'; c.since = now; }
      break;
    case 'hide':
      c.progress = 1 - Math.min(el / HIDE_MS, 1);
      if (el >= HIDE_MS) { c.state = 'hidden'; c.progress = 0; }
      break;
    default: c.progress = 0;
  }
}

// 동그란 파스텔 몸 + 눈(깜빡임) + 볼 + 작은 팔. (cx, cy)=하단 중심, size=폭.
function drawCharacter(ctx, cx, cy, size, t, waving = false) {
  const r = size / 2;
  const bodyCy = cy - r;             // 몸 중심
  const blink = (t % 3200) < 120;    // 3.2초마다 120ms 깜빡
  ctx.save();
  // 팔
  ctx.strokeStyle = '#f6a6b2'; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(3, size * 0.09);
  const armY = bodyCy + r * 0.15, wave = Math.sin(t / 250) * 0.15;
  ctx.beginPath(); ctx.moveTo(cx - r * 0.85, armY); ctx.lineTo(cx - r * 1.25, armY - r * (0.35 + wave)); ctx.stroke();
  if (waving) { // S5: 오른팔을 머리 위로 올려 좌우로 흔들기
    const swing = Math.sin(t / 60) * 0.35;
    ctx.beginPath(); ctx.moveTo(cx + r * 0.85, armY - r * 0.2); ctx.lineTo(cx + r * (1.1 + swing), armY - r * 1.2); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(cx + r * 0.85, armY); ctx.lineTo(cx + r * 1.25, armY - r * (0.35 - wave)); ctx.stroke();
  }
  // 몸
  ctx.fillStyle = '#ffc6d0'; ctx.strokeStyle = '#d98a9a'; ctx.lineWidth = Math.max(2, size * 0.03);
  ctx.beginPath(); ctx.arc(cx, bodyCy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // 볼
  ctx.fillStyle = 'rgba(255,120,140,.55)';
  ctx.beginPath(); ctx.ellipse(cx - r * 0.5, bodyCy + r * 0.15, r * 0.16, r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + r * 0.5, bodyCy + r * 0.15, r * 0.16, r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
  // 눈
  ctx.fillStyle = '#333';
  for (const sx of [-1, 1]) {
    const ex = cx + sx * r * 0.3, ey = bodyCy - r * 0.15;
    if (blink) { ctx.lineWidth = Math.max(2, size * 0.03); ctx.strokeStyle = '#333'; ctx.beginPath(); ctx.moveTo(ex - r * 0.1, ey); ctx.lineTo(ex + r * 0.1, ey); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(ex, ey, r * 0.09, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex + r * 0.03, ey - r * 0.03, r * 0.03, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#333'; }
  }
  // 입
  ctx.strokeStyle = '#a05a6a'; ctx.lineWidth = Math.max(2, size * 0.025);
  ctx.beginPath(); ctx.arc(cx, bodyCy + r * 0.12, r * 0.14, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.restore();
}

// 캐릭터의 현재 화면 배치 (하단 중심 x, y, 폭). 락이 없으면 null.
function characterPlacement(t) {
  const b = lockedScreenBox(); if (!b) return null;
  const c = state.char;
  const dpr = canvas.width / canvas.clientWidth;
  let bob = c.state === 'idle' ? Math.sin(t / 400) * 2 * dpr : 0;
  if (c.state === 'wave') bob = -Math.abs(Math.sin((t - c.since) / WAVE_MS * Math.PI * 2)) * 0.12 * b.h; // S5: 점프
  const anchorY = b.y + b.h * (0.6 - 0.45 * c.progress) + bob; // 0.6h → 0.15h
  return { cx: b.x + b.w / 2, cy: anchorY, size: b.w * 0.8, box: b };
}

// S3: 합성 — (1) video → (2) 캐릭터 → (3) video의 락 bbox 영역 재도장(사각 오클루전)
function composite(t) {
  const { s, ox, oy, vw, vh } = coverTransform();
  ctx.drawImage(video, ox, oy, vw * s, vh * s);
  updateCharacter(t);
  const p = characterPlacement(t);
  if (p && state.char.state !== 'hidden') {
    drawCharacter(ctx, p.cx, p.cy, p.size, t, state.char.state === 'wave'); // S5
    if (!(USE_MASK && occludeWithMask(s, ox, oy, vw, vh))) occlude(p, s, ox, oy, vw, vh); // S4 → S3 폴백
  }
  if (!state.lock) state.mask = null; // S4: 락 해제 시 마스크 폐기
}

function occlude(p, s, ox, oy, vw, vh) {
  const L = state.lock.box;
  const sx = Math.max(0, L.x), sy = Math.max(0, L.y);
  const sw = Math.min(vw, L.x + L.w) - sx, sh = Math.min(vh, L.y + L.h) - sy;
  if (sw > 0 && sh > 0) ctx.drawImage(video, sx, sy, sw, sh, ox + sx * s, oy + sy * s, sw * s, sh * s);
}

// ---- 렌더 루프 (rAF) ----
function drawDetections(t) {
  const { s, ox, oy } = coverTransform();
  ctx.font = `${14 * (canvas.width / canvas.clientWidth)}px ui-monospace, monospace`;
  for (const d of state.detections) {
    const x = ox + d.x * s, y = oy + d.y * s, w = d.w * s, h = d.h * s;
    ctx.lineWidth = 1; // S2: 락되지 않은 검출은 얇게
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.strokeRect(x, y, w, h);
    const label = `${d.label} ${d.score.toFixed(2)}`;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(x, y - 18, ctx.measureText(label).width + 8, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 4, y - 4);
  }
  // S2: 락된 bbox(스무딩 후)는 굵게
  const L = state.lock;
  if (L) {
    const b = L.box;
    ctx.lineWidth = 4; ctx.strokeStyle = '#ffd54f';
    ctx.strokeRect(ox + b.x * s, oy + b.y * s, b.w * s, b.h * s);
  }
}

// S2: 화면 좌표계의 락 bbox (스무딩 후). 없으면 null.
function lockedScreenBox() {
  const L = state.lock; if (!L) return null;
  const { s, ox, oy } = coverTransform();
  return { x: ox + L.box.x * s, y: oy + L.box.y * s, w: L.box.w * s, h: L.box.h * s };
}

function render(t) {
  state.frameTimes.push(t);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (video.videoWidth) { composite(t); if (params.get('debug') !== '0') drawDetections(t); } // S3
  updateHint(); // S5
  hud.textContent =
    `det ${hz(state.detTimes, t)} Hz | seg ${hz(state.segTimes, t)} Hz | fps ${hz(state.frameTimes, t)} | ${state.delegate}\n` +
    `video ${video.videoWidth}x${video.videoHeight}\n` +
    `lock ${state.lock ? state.lock.label : '-'} | miss ${(state.missMs / 1000).toFixed(1)}s | char ${state.char.state}\n` +
    `mask ${USE_MASK ? (state.mask ? 'on' : 'none') : 'off'} | rej ${state.maskRejects}` +
    (state.error ? `\nERR ${state.error}` : '');
  requestAnimationFrame(render);
}

// ---- S5: 상호작용 + 공유 ----
const shutterBtn = document.getElementById('shutter');

// 캐릭터 영역(몸 원) 탭 → wave
function onTap(ev) {
  const c = state.char;
  if (c.state !== 'idle' && c.state !== 'peek') return;
  const p = characterPlacement(performance.now()); if (!p) return;
  const rect = canvas.getBoundingClientRect(), dpr = canvas.width / rect.width;
  const x = (ev.clientX - rect.left) * dpr, y = (ev.clientY - rect.top) * dpr;
  const r = p.size / 2, bx = p.cx, by = p.cy - r;
  if (Math.hypot(x - bx, y - by) <= r * 1.3) { c.state = 'wave'; c.since = performance.now(); }
}
canvas.addEventListener('pointerdown', onTap);

// 셔터: 캔버스 → JPEG → Web Share API, 안 되면 다운로드
async function shoot() {
  shutterBtn.disabled = true;
  try {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    const file = new File([blob], `peekaboo-${Date.now()}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Peekaboo AR' });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    state.shots++;
  } catch (e) { if (e.name !== 'AbortError') { console.error(e); state.error = e.message; } }
  finally { shutterBtn.disabled = false; }
}
shutterBtn.addEventListener('click', shoot);

// 안내 문구: 락 전엔 "컵을 비춰보세요", 락되면 사라짐
function updateHint() {
  if (state.error || !detector) return;
  msg.textContent = state.lock ? '' : '컵을 비춰보세요';
}

// ---- 시작 ----
async function main() {
  startBtn.hidden = true;
  resizeCanvas();
  try {
    await startCamera();
    msg.textContent = '모델 로딩 중…';
    await createDetector();
    await createSegmenter(); // S4
    msg.textContent = '';
    shutterBtn.hidden = false; // S5
    video.requestVideoFrameCallback(onVideoFrame);
  } catch (e) {
    console.error(e);
    state.error = e.message || String(e);
    msg.textContent = `오류: ${state.error}\n(HTTPS·카메라 권한을 확인하세요)`;
  }
}

requestAnimationFrame(render);
startBtn.addEventListener('click', main, { once: true });

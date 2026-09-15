// Peekaboo AR — 물체 뒤 캐릭터. 단계 번호(S1, S2, ...)는 각 코드가 추가된 단계다.
// S1: 카메라 + MediaPipe ObjectDetector 루프 + 디버그 오버레이
// S2: 타깃 락(가장 큰 허용 클래스 → IoU 매칭) + One Euro 필터 스무딩
// S3: 2D 캔버스 캐릭터 등장(peek/idle/hide) + bbox 사각형 오클루전
// S4: InteractiveSegmenter(MagicTouch) 마스크 오클루전 (EMA + 블러, bbox IoU 게이트)
// S5: 탭 → wave, 셔터 → 공유/저장, 안내 문구
// S7: 게임화 — 물체 기억(localStorage), 5초 유지 후 등장, 검댕이 캐릭터, 탭 수집/도감
// S8: 공간 스캔 → 대상 물체 무작위 선택 → 물체 뒤 발광(가까울수록 강하게) → 5초 충전 → 짠! 등장

const VISION_VERSION = '0.10.35';
const VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const SEGMENTER_MODEL = 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite';
const DETECTOR_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

// S2: 락 대상 클래스 → S9: COCO 80종 중 제외 목록 빼고 전부 (바닥·책상 위에 놓이는 물체는 모두 타깃 가능)
const EXCLUDED = new Set([
  'person', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', // 사람·동물
  'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',                   // 탈것
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter',                                 // 거리 시설물
  'dining table', 'bed',                                                                         // 화면을 다 덮는 큰 면
]);
const isTargetable = (label) => !EXCLUDED.has(label);
const ALLOWED = { includes: isTargetable }; // 기존 호출부(ALLOWED.includes) 유지
const LOCK_MIN_SCORE = 0.5;
const LOCK_MIN_IOU = 0.3;
const LOCK_LOST_MS = 1000;

// S4: 마스크 설정
const SEG_INTERVAL_MS = 100;
const MASK_EMA = 0.5;         // 깜빡임 심하면 0.7(prev)/0.3(new)
const MASK_MIN_IOU = 0.2;     // 마스크-bbox IoU가 이보다 낮으면 그 마스크는 버림
const MASK_BLUR_PX = 2;

// S7: 게임 설정
const CONFIRM_HITS = 3;       // 연속 매칭 n회 → "타깃 확실"
const HOLD_MS = 5000;         // 확정 상태를 이만큼 유지해야 등장
// S8: 스캔·발광
const SCAN_MS = 6000;         // 최소 스캔 시간. 허용 물체가 하나도 안 보이면 계속 스캔
const NEAR_MIN = 0.15, NEAR_MAX = 0.6; // bbox 폭/영상 폭 → 0(멀다)~1(가깝다)
const SPRITES = [             // 캐릭터 6종 = 별사탕 색. 수집 대상 식별자.
  { id: 'pink',   color: '#f48fb1', name: '분홍' },
  { id: 'green',  color: '#81c784', name: '초록' },
  { id: 'yellow', color: '#fff176', name: '노랑' },
  { id: 'blue',   color: '#64b5f6', name: '파랑' },
  { id: 'orange', color: '#ffb74d', name: '주황' },
  { id: 'purple', color: '#b39ddb', name: '보라' },
];
const store = {
  get(k, d) { try { const v = localStorage.getItem('peekaboo.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('peekaboo.' + k, JSON.stringify(v)); } catch {} },
  clear() { try { localStorage.removeItem('peekaboo.home'); localStorage.removeItem('peekaboo.collection'); } catch {} },
};

const params = new URLSearchParams(location.search);
const USE_MASK = params.get('mask') !== '0';
if (params.get('reset') === '1') store.clear(); // S7: ?reset=1 → 기억·도감 초기화
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
  // S3 (S7에서 확장): hidden → charging → peek → idle ⇄ wave/collect → hide
  char: { state: 'hidden', since: 0, progress: 0, sprite: null },
  // S7
  home: store.get('home', null),            // { label, savedAt, seen } S8: 스캔 결과에서 고른 대상 물체
  // S8
  phase: store.get('home', null) ? 'play' : 'scan',
  scan: { start: 0, seen: {} },             // seen[label] = { n, maxW }
  near: 0,                                  // 0~1 대상 물체와의 가까움(bbox 폭 기준)
  collection: store.get('collection', []),  // [{ id, label, at }]
  hits: 0,                                  // 현재 락의 연속 매칭 횟수
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
      // S7/S8: 스캔에서 고른 물체 클래스만
      const ok = state.home ? d.label === state.home.label : false;
      if (!ok || d.score < LOCK_MIN_SCORE) continue;
      if (!best || d.w * d.h > best.w * best.h) best = d;
    }
    if (best) {
      const f = makeFilters();
      state.lock = {
        label: best.label, raw: { ...best }, filters: f, lastSeen: now,
        box: { x: f.x.filter(best.x, now), y: f.y.filter(best.y, now), w: f.w.filter(best.w, now), h: f.h.filter(best.h, now) },
      };
      state.missMs = 0;
      state.hits = 1; // S7
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
    state.hits++; // S7
  } else {
    state.missMs = now - lock.lastSeen;
    if (state.missMs >= LOCK_LOST_MS) { state.lock = null; state.missMs = 0; state.hits = 0; }
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
    if (state.phase === 'scan') recordScan(state.detections); // S8
    else updateTracker(state.detections, performance.now()); // S2
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

// ---- S8: 공간 스캔 → 대상 물체 선택 ----
function startScan(now) {
  state.phase = 'scan'; state.scan = { start: now, seen: {} };
  state.lock = null; state.hits = 0; state.mask = null;
}
function recordScan(dets) {
  for (const d of dets) {
    if (!ALLOWED.includes(d.label) || d.score < LOCK_MIN_SCORE) continue;
    const s = state.scan.seen[d.label] ??= { n: 0, maxW: 0 };
    s.n++; s.maxW = Math.max(s.maxW, d.w);
  }
}
// 스캔 종료 조건: 최소 시간 경과 + 허용 물체 1개 이상. 그중 하나를 무작위로 골라 저장(플레이어에겐 비밀).
function maybeFinishScan(now) {
  if (state.phase !== 'scan') return;
  if (!state.scan.start) state.scan.start = now;
  const labels = Object.keys(state.scan.seen).filter((l) => state.scan.seen[l].n >= 2);
  if (now - state.scan.start < SCAN_MS || !labels.length) return;
  const label = labels[Math.floor(Math.random() * labels.length)];
  state.home = { label, savedAt: Date.now(), seen: labels };
  store.set('home', state.home);
  state.phase = 'play';
  renderBadge();
}
// 스캔 중 화면: 중앙 진행 링 + 발견한 물체 수
function drawScan(ctx, t) {
  const k = Math.min((t - state.scan.start) / SCAN_MS, 1);
  const cx = canvas.width / 2, cy = canvas.height / 2, r = Math.min(canvas.width, canvas.height) * 0.12;
  ctx.save();
  ctx.lineWidth = Math.max(3, r * 0.08); ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#ffd54f'; ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke();
  // 회전하는 스캔 바늘
  const a = t / 600; ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r * 0.85, cy + Math.sin(a) * r * 0.85); ctx.stroke();
  ctx.restore();
}

// S8: 가까움 = 스무딩된 bbox 폭 / 영상 폭을 NEAR_MIN~NEAR_MAX로 정규화
function updateNear() {
  const L = state.lock;
  state.near = L ? Math.max(0, Math.min(1, (L.box.w / video.videoWidth - NEAR_MIN) / (NEAR_MAX - NEAR_MIN))) : 0;
}
// S8: 물체 뒤 발광. 캐릭터보다 먼저 그리고, 그 위에 마스크로 잘라낸 물체 픽셀이 덮여 "뒤에서 새어 나오는" 빛이 된다.
function drawGlow(ctx, b, t) {
  const c = state.char;
  const charging = c.state === 'charging' ? (t - c.since) / HOLD_MS : c.state === 'hidden' ? 0 : 1;
  const pulse = 0.5 + 0.5 * Math.sin(t / (charging ? 180 + 420 * (1 - charging) : 700)); // 충전 중엔 점점 빠르게 깜빡
  const strength = (0.25 + 0.75 * state.near) * (0.6 + 0.4 * pulse) * (0.7 + 0.3 * charging);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const R = Math.max(b.w, b.h) * (0.7 + 0.5 * state.near + 0.2 * pulse);
  const g = ctx.createRadialGradient(cx, cy, R * 0.15, cx, cy, R);
  g.addColorStop(0, `rgba(255,236,150,${0.95 * strength})`);
  g.addColorStop(0.5, `rgba(255,210,90,${0.45 * strength})`);
  g.addColorStop(1, 'rgba(255,200,80,0)');
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2); ctx.restore();
}
// S8: 짠! 등장 버스트
function drawPop(ctx, cx, cy, size, t, k) {
  const r = size / 2, by = cy - r;
  ctx.save();
  ctx.globalAlpha = 1 - k;
  ctx.strokeStyle = '#fff59d'; ctx.lineWidth = Math.max(2, size * 0.04); ctx.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + t / 4000, d0 = r * (1.1 + k * 1.4), d1 = d0 + r * (0.35 - 0.2 * k);
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * d0, by + Math.sin(a) * d0); ctx.lineTo(cx + Math.cos(a) * d1, by + Math.sin(a) * d1); ctx.stroke();
  }
  ctx.globalAlpha = 1 - Math.max(0, k - 0.5) * 2;
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#333'; ctx.lineWidth = Math.max(2, size * 0.03);
  ctx.font = `bold ${r * 0.6}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const ty = by - r * (1.5 + k * 0.4);
  ctx.strokeText('짠!', cx, ty); ctx.fillText('짠!', cx, ty);
  ctx.restore();
}

// ---- S3/S7: 캐릭터 ----
const PEEK_MS = 450, HIDE_MS = 300, WAVE_MS = 800, COLLECT_MS = 900, POP_MS = 700; // S8: 짠! 하고 빠르게 등장
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const confirmed = () => !!state.lock && state.hits >= CONFIRM_HITS; // S7: 타깃 확실

function isCollected(id) { return state.collection.some((c) => c.id === id); }

// S7: 등장할 캐릭터 고르기 — 미수집이 남아 있으면 70% 확률로 미수집 중에서
function pickSprite() {
  const left = SPRITES.filter((s) => !isCollected(s.id));
  const pool = left.length && Math.random() < 0.7 ? left : SPRITES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 상태 전이. progress 0=숨김(bbox.y+0.6h), 1=완전 등장(bbox.y+0.15h)
function updateCharacter(now) {
  const c = state.char;
  const locked = !!state.lock;
  if (!locked && c.state !== 'hidden' && c.state !== 'hide') {
    if (c.state === 'charging') { c.state = 'hidden'; c.progress = 0; } // 아직 안 나왔으면 바로 숨김
    else { c.state = 'hide'; c.since = now; }
  }
  if (confirmed() && (c.state === 'hidden' || c.state === 'hide')) { // S7: 확정되면 충전 시작
    c.state = 'charging'; c.since = now; c.progress = 0; c.sprite = pickSprite();
  }
  const el = now - c.since;
  switch (c.state) {
    case 'charging': // S7: 5초 유지 → peek
      c.progress = 0;
      if (el >= HOLD_MS) { c.state = 'peek'; c.since = now; }
      break;
    case 'peek': // S8: easeOutBack으로 튀어나옴 + 버스트(POP_MS 동안)
      c.progress = easeOutBack(Math.min(el / PEEK_MS, 1));
      if (el >= POP_MS) { c.state = 'idle'; c.since = now; c.progress = 1; }
      break;
    case 'idle': c.progress = 1; break;
    case 'wave': // S5: 0.8초 동안 흔들기 + 살짝 점프
      c.progress = 1;
      if (el >= WAVE_MS) { c.state = 'idle'; c.since = now; }
      break;
    case 'collect': // S7: 수집 연출
      c.progress = 1;
      if (el >= COLLECT_MS) { c.state = 'idle'; c.since = now; }
      break;
    case 'hide':
      c.progress = 1 - Math.min(el / HIDE_MS, 1);
      if (el >= HIDE_MS) { c.state = 'hidden'; c.progress = 0; }
      break;
    default: c.progress = 0;
  }
}

// S7: 별사탕(콘페이토). (x,y) 중심, rr 반지름
function drawCandy(ctx, x, y, rr, color, t) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(t / 1500);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, r = i % 2 ? rr : rr * 0.62;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  for (const [dx, dy] of [[-0.3, -0.25], [0.25, -0.1], [-0.05, 0.3]]) { ctx.beginPath(); ctx.arc(dx * rr, dy * rr, rr * 0.13, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

// S7: 검댕이 — 까만 털뭉치 몸 + 큰 흰 눈. (cx, cy)=하단 중심, size=폭.
// opts: { sprite, collected, waving, collecting, collectT }
function drawCharacter(ctx, cx, cy, size, t, opts = {}) {
  const r = size / 2;
  const bodyCy = cy - r;
  const blink = (t % 3400) < 110;
  const wobble = opts.waving ? Math.sin(t / 60) * 0.08 : 0;
  ctx.save();
  ctx.globalAlpha = opts.collected ? 1 : 0.86; // 미수집은 살짝 옅게
  ctx.translate(cx, bodyCy); ctx.rotate(wobble); ctx.translate(-cx, -bodyCy);
  // 털
  ctx.strokeStyle = '#151515'; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(2, size * 0.045);
  const N = 40;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const len = r * (0.14 + 0.13 * (((i * 7919) % 13) / 13)) + r * 0.04 * Math.sin(t / 220 + i);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.9, bodyCy + Math.sin(a) * r * 0.9);
    ctx.lineTo(cx + Math.cos(a) * (r + len), bodyCy + Math.sin(a) * (r + len));
    ctx.stroke();
  }
  // 몸
  ctx.fillStyle = '#1b1b1b';
  ctx.beginPath(); ctx.arc(cx, bodyCy, r, 0, Math.PI * 2); ctx.fill();
  // 눈
  const look = Math.sin(t / 900) * r * 0.04;
  for (const sx of [-1, 1]) {
    const ex = cx + sx * r * 0.34, ey = bodyCy - r * 0.05;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(ex, ey, r * 0.24, blink ? r * 0.03 : r * 0.29, 0, 0, Math.PI * 2); ctx.fill();
    if (!blink) { ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(ex + look, ey + r * 0.03, r * 0.11, 0, Math.PI * 2); ctx.fill(); }
  }
  // 별사탕: 수집됨 = 들고 있음. 수집 중이면 커지며 등장
  if (opts.sprite && (opts.collected || opts.collecting)) {
    const k = opts.collecting ? easeOutBack(Math.min(opts.collectT, 1)) : 1;
    drawCandy(ctx, cx + r * 0.62, bodyCy + r * 0.55, r * 0.26 * Math.max(k, 0.01), opts.sprite.color, t);
  }
  // 미수집: 머리 위 "!" 말풍선
  if (opts.sprite && !opts.collected && !opts.collecting) {
    ctx.globalAlpha = 1;
    const bx = cx + r * 0.95, by = bodyCy - r * 1.25 + Math.sin(t / 300) * r * 0.05;
    ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.arc(bx, by, r * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#333'; ctx.font = `bold ${r * 0.3}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('!', bx, by + r * 0.01);
  }
  // 수집 연출: 반짝이
  if (opts.collecting) {
    ctx.globalAlpha = 1 - Math.min(opts.collectT, 1);
    ctx.strokeStyle = opts.sprite?.color ?? '#fff'; ctx.lineWidth = Math.max(2, size * 0.03);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, d0 = r * (1.2 + opts.collectT * 0.8), d1 = d0 + r * 0.25;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * d0, bodyCy + Math.sin(a) * d0); ctx.lineTo(cx + Math.cos(a) * d1, bodyCy + Math.sin(a) * d1); ctx.stroke();
    }
  }
  ctx.restore();
}
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

// S7: 충전 연출 — 물체 위로 검댕 알갱이가 떠오르고, 상단에 진행 호
function drawCharging(ctx, b, t, k) {
  ctx.save();
  const cx = b.x + b.w / 2, top = b.y;
  const range = b.h * 0.35;
  for (let i = 0; i < 8; i++) {
    const phase = ((t / 7 + i * 61) % range);
    const x = cx + (i - 3.5) * b.w * 0.11 + Math.sin(t / 450 + i) * b.w * 0.03;
    const y = top - phase;
    ctx.globalAlpha = k * (1 - phase / range) * 0.9;
    ctx.fillStyle = '#1b1b1b';
    ctx.beginPath(); ctx.arc(x, y, b.w * (0.012 + 0.012 * k), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = Math.max(2, b.w * 0.02);
  ctx.beginPath(); ctx.arc(cx, top - b.h * 0.12, b.w * 0.16, -Math.PI / 2, Math.PI * 1.5); ctx.stroke();
  ctx.strokeStyle = '#ffd54f';
  ctx.beginPath(); ctx.arc(cx, top - b.h * 0.12, b.w * 0.16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke();
  ctx.restore();
}

// 캐릭터의 현재 화면 배치 (하단 중심 x, y, 폭). 락이 없으면 null.
function characterPlacement(t) {
  const b = lockedScreenBox(); if (!b) return null;
  const c = state.char;
  const dpr = canvas.width / canvas.clientWidth;
  let bob = c.state === 'idle' ? Math.sin(t / 400) * 2 * dpr : 0;
  if (c.state === 'wave') bob = -Math.abs(Math.sin((t - c.since) / WAVE_MS * Math.PI * 2)) * 0.12 * b.h; // S5: 점프
  if (c.state === 'collect') bob = -Math.abs(Math.sin((t - c.since) / COLLECT_MS * Math.PI)) * 0.2 * b.h; // S7: 큰 점프
  const anchorY = b.y + b.h * (0.6 - 0.45 * c.progress) + bob; // 0.6h → 0.15h
  return { cx: b.x + b.w / 2, cy: anchorY, size: b.w * 0.8, box: b };
}

// S3: 합성 — (1) video → (2) 캐릭터 → (3) video의 락 bbox 영역 재도장(사각 오클루전)
function composite(t) {
  const { s, ox, oy, vw, vh } = coverTransform();
  ctx.drawImage(video, ox, oy, vw * s, vh * s);
  updateCharacter(t);
  const p = characterPlacement(t);
  const c = state.char;
  updateNear(); // S8
  if (p && state.phase === 'play') drawGlow(ctx, p.box, t); // S8: 물체 뒤 발광 (캐릭터·오클루전보다 먼저)
  if (p && c.state !== 'hidden' && c.state !== 'charging') {
    drawCharacter(ctx, p.cx, p.cy, p.size, t, { // S7
      sprite: c.sprite, collected: c.sprite && isCollected(c.sprite.id) && c.state !== 'collect',
      waving: c.state === 'wave', collecting: c.state === 'collect', collectT: (t - c.since) / COLLECT_MS,
    });
    if (!(USE_MASK && occludeWithMask(s, ox, oy, vw, vh))) occlude(p, s, ox, oy, vw, vh); // S4 → S3 폴백
  }
  if (p && c.state === 'charging') drawCharging(ctx, p.box, t, Math.min((t - c.since) / HOLD_MS, 1)); // S7
  if (p && c.state === 'peek') drawPop(ctx, p.cx, p.cy, p.size, t, Math.min((t - c.since) / POP_MS, 1)); // S8
  if (state.phase === 'scan') { maybeFinishScan(t); if (state.phase === 'scan') drawScan(ctx, t); } // S8
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
    `mask ${USE_MASK ? (state.mask ? 'on' : 'none') : 'off'} | rej ${state.maskRejects}\n` +
    `phase ${state.phase} | home ${state.home?.label ?? '-'} | near ${state.near.toFixed(2)} | hits ${state.hits}\n` +
    `sprite ${state.char.sprite?.id ?? '-'} | col ${state.collection.length}/${SPRITES.length}` +
    (state.error ? `\nERR ${state.error}` : '');
  requestAnimationFrame(render);
}

// ---- S5: 상호작용 + 공유 ----
const shutterBtn = document.getElementById('shutter');

// 캐릭터 영역(몸 원) 탭 → S7: 미수집이면 수집, 수집됐으면 모션만(wave)
function onTap(ev) {
  const c = state.char;
  if (c.state !== 'idle') return;
  const p = characterPlacement(performance.now()); if (!p) return;
  const rect = canvas.getBoundingClientRect(), dpr = canvas.width / rect.width;
  const x = (ev.clientX - rect.left) * dpr, y = (ev.clientY - rect.top) * dpr;
  const r = p.size / 2, bx = p.cx, by = p.cy - r;
  if (Math.hypot(x - bx, y - by) > r * 1.3) return;
  if (c.sprite && !isCollected(c.sprite.id)) {
    state.collection.push({ id: c.sprite.id, label: state.lock?.label ?? '?', at: Date.now() });
    store.set('collection', state.collection);
    c.state = 'collect'; c.since = performance.now();
    renderBadge();
  } else { c.state = 'wave'; c.since = performance.now(); }
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

// 안내 문구 (S7에서 확장)
function updateHint() {
  if (state.error || !detector) return;
  const c = state.char;
  let text = '';
  if (state.phase === 'scan') { // S8
    const n = Object.keys(state.scan.seen).length;
    text = n ? `주변을 천천히 둘러보세요… 물체 ${n}개 발견` : '주변을 천천히 둘러보세요';
  }
  else if (!state.lock) text = '이 공간 어딘가에 검댕이가 숨어 있어요. 빛나는 물건을 찾아보세요';
  else if (c.state === 'hidden' || c.state === 'hide') text = state.near < 0.5 ? '빛이 보여요! 더 가까이…' : '여기다! 가만히 비춰보세요';
  else if (c.state === 'charging') text = `뭔가 나올 것 같아… (${Math.max(0, Math.ceil((HOLD_MS - (performance.now() - c.since)) / 1000))})`;
  else if (c.state === 'idle' && c.sprite && !isCollected(c.sprite.id)) text = '탭해서 수집!';
  if (msg.textContent !== text) msg.textContent = text;
}

// ---- S7: 도감 UI ----
const badge = document.getElementById('badge');
const panel = document.getElementById('panel');
function renderBadge() { badge.textContent = `★ ${state.collection.length}/${SPRITES.length}`; }
function renderPanel() {
  const slots = panel.querySelector('#slots');
  slots.innerHTML = '';
  for (const s of SPRITES) {
    const got = state.collection.find((c) => c.id === s.id);
    const el = document.createElement('div'); el.className = 'slot' + (got ? ' got' : '');
    const cv = document.createElement('canvas'); cv.width = cv.height = 96;
    const g = cv.getContext('2d');
    if (got) drawCharacter(g, 48, 84, 52, 1000, { sprite: s, collected: true });
    else { g.globalAlpha = 0.25; drawCharacter(g, 48, 84, 52, 1000, {}); }
    el.appendChild(cv);
    const cap = document.createElement('div'); cap.textContent = got ? `${s.name} · ${got.label}` : '???';
    el.appendChild(cap); slots.appendChild(el);
  }
  panel.querySelector('#home').textContent = state.home
    ? `숨은 곳: ${state.collection.length ? state.home.label : '??? (빛나는 물건을 찾아보세요)'} · 스캔에서 본 물체: ${(state.home.seen ?? [state.home.label]).join(', ')}`
    : '스캔 중…';
}
badge.addEventListener('click', () => { renderPanel(); panel.hidden = !panel.hidden; });
panel.addEventListener('click', (e) => { if (e.target === panel) panel.hidden = true; });
panel.querySelector('#reset').addEventListener('click', () => {
  if (!confirm('기억한 물체와 도감을 모두 지울까요?')) return;
  store.clear(); state.home = null; state.collection = [];
  startScan(performance.now()); // S8: 다시 스캔
  renderBadge(); renderPanel(); panel.hidden = true;
});

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
    badge.hidden = false; renderBadge(); // S7
    if (state.phase === 'scan') startScan(performance.now()); // S8
    video.requestVideoFrameCallback(onVideoFrame);
  } catch (e) {
    console.error(e);
    state.error = e.message || String(e);
    msg.textContent = `오류: ${state.error}\n(HTTPS·카메라 권한을 확인하세요)`;
  }
}

requestAnimationFrame(render);
startBtn.addEventListener('click', main, { once: true });

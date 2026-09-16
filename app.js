// Peekaboo AR — 물체 뒤 캐릭터. 단계 번호(S1, S2, ...)는 각 코드가 추가된 단계다.
// S1: 카메라 + MediaPipe ObjectDetector 루프 + 디버그 오버레이
// S2: 타깃 락(가장 큰 허용 클래스 → IoU 매칭) + One Euro 필터 스무딩
// S3: 2D 캔버스 캐릭터 등장(peek/idle/hide) + bbox 사각형 오클루전
// S4: InteractiveSegmenter(MagicTouch) 마스크 오클루전 (EMA + 블러, bbox IoU 게이트)
// S5: 탭 → wave, 셔터 → 공유/저장, 안내 문구
// S7: 게임화 — 물체 기억(localStorage), 5초 유지 후 등장, 검댕이 캐릭터, 탭 수집/도감
// S8: 공간 스캔 → 대상 물체 무작위 선택 → 물체 뒤 발광(가까울수록 강하게) → 5초 충전 → 짠! 등장
// S10: 큰 물체는 옆에서 등장(화면 위 여유 없을 때) + 한 번 맞춘 물체는 이후 즉시 등장
// S11: 짠! 대신 스을쩍 — 물체에 완전히 가려진 위치에서 뒤뚱거리며 걸어 나오고, 중간에 한 번 움찔 물러난다
// S12: 패럴랙스 — 평소엔 반쯤 숨어 있고, 폰을 옆·위로 움직이면(물체가 화면에서 치우치면) 뒤에 숨은 캐릭터가 더 드러난다
// S16: 등장 후엔 캐릭터에 집중 — 발광은 사그라들고, 캐릭터 주변만 밝은 스포트라이트(나머지 어둡게), 캐릭터는 불투명, 검출 박스는 ?debug=1일 때만
// S15: 타깃 못 잡는 문제 — 스캔은 딱 5초, 그동안 본 물체 중에서만 선정. 자이로로 물체 방향을 기억해 화면 밖이면 상하좌우 엣지 발광으로 카메라를 유도
// S14: 못 찾는 문제 대응 — 스캔에서 충분히(4회↑) 본 물체만 후보, 본 횟수 가중 선택, 후보 목록·20초 뒤 라벨 힌트, 밝은 배경에서도 보이는 발광 링
// S13: 먼작귀 도감 — 별사탕 6색 대신 캐릭터 15종. 물체 라벨마다 사는 종이 다르고, 희귀도·심야 시크릿·세트가 있다. 그림은 공식 에셋 슬롯(assets/skins/chiikawa/)이며 없으면 이름표 실루엣

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
const LOCK_MIN_SCORE = 0.4;   // S15: 검출기 문턱(0.4)과 같게. 실물은 0.4~0.6대가 흔하다
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
const SCAN_MS = 5000;         // S15: 스캔 5초. 그동안 본 물체 중에서만 선정
const SCAN_MIN_HITS = 3;      // S14: 이 횟수 이상 본 물체만 후보 (검출이 깜빡인 라벨 제외)
const SCAN_MAX_MS = 10000;    // S14: 이 시간이 지나면 1회라도 본 물체까지 후보로 완화
const EDGE_HINT_DEG = 8;      // S15: 목표 방향과 이보다 벌어지면 엣지 발광
const EDGE_FULL_DEG = 50;     // S15: 이만큼 벌어지면 엣지 발광 최대
const HINT_AFTER_MS = 20000;  // S14: 이만큼 못 찾으면 라벨 힌트
const NEAR_MIN = 0.15, NEAR_MAX = 0.6; // bbox 폭/영상 폭 → 0(멀다)~1(가깝다)
// S12: 패럴랙스. 물체가 화면 중앙에서 얼마나 치우쳤는지(-1~1)를 카메라 이동의 근사치로 쓴다.
const PARALLAX_X = 0.55;   // 가로 최대 이동 = bbox 폭 × 이 값
const PARALLAX_Y = 0.35;   // 세로 최대 이동 = bbox 높이 × 이 값 (위에서 내려다볼 때)
const PARALLAX_SMOOTH = 0.12;
// S13: 먼작귀 도감. 이름은 팬 위키 기준 가칭이며 라이선스 시 공식 캐릭터 시트로 교체한다(docs/preview/chiikawa-lab.html).
// objects = 이 종이 사는 물체(COCO 라벨). 비어 있으면 어디서도 안 나오고 night 종은 심야(22~05시)에만 어디서든 낮은 확률로 나온다.
const SKIN = { id: 'chiikawa', dir: './assets/skins/chiikawa/', ext: 'png' }; // <dir>/manifest.json 에 적힌 id의 PNG를 그린다. 없으면 실루엣
const RARITY = {
  C: { name: '흔함', w: 10, color: '#B8B2A8' },
  U: { name: '보통', w: 5,  color: '#5FA36E' },
  R: { name: '희귀', w: 2,  color: '#4A8DE0' },
  L: { name: '전설', w: 1,  color: '#E0A020' },
};
const SETS = ['주역', '친구', '갑옷'];
const SPECIES = [
  { id: 'chiikawa',    name: '치이카와',        jp: 'ちいかわ',            group: '주역', rarity: 'C', color: '#F7F3EA', tone: '#F6B7C2', objects: ['cup', 'bowl', 'bottle', 'teddy bear', 'book', 'backpack', 'chair', 'handbag'] },
  { id: 'hachiware',   name: '하치와레',        jp: 'ハチワレ',            group: '주역', rarity: 'C', color: '#F7F3EA', tone: '#9EC5EA', objects: ['book', 'laptop', 'keyboard', 'cell phone', 'remote', 'tv', 'scissors', 'mouse'] },
  { id: 'usagi',       name: '우사기',          jp: 'うさぎ',              group: '주역', rarity: 'C', color: '#FBF5DE', tone: '#F5D26B', objects: ['potted plant', 'sports ball', 'frisbee', 'kite', 'banana', 'carrot', 'skateboard', 'umbrella'] },
  { id: 'momonga',     name: '모몽가',          jp: 'モモンガ',            group: '친구', rarity: 'U', color: '#F0EEF8', tone: '#C9B6E8', objects: ['laptop', 'mouse', 'keyboard', 'tv', 'clock', 'vase'] },
  { id: 'kurimanju',   name: '쿠리만쥬',        jp: 'くりまんじゅう',      group: '친구', rarity: 'U', color: '#F2E3C8', tone: '#C7955C', objects: ['bottle', 'wine glass', 'cup', 'couch', 'refrigerator', 'pizza', 'hot dog', 'sandwich'] },
  { id: 'shisa',       name: '시사',            jp: 'シーサー',            group: '친구', rarity: 'U', color: '#FBE3D5', tone: '#F09A7A', objects: ['chair', 'bench', 'microwave', 'oven', 'toaster', 'donut', 'cake'] },
  { id: 'futaba',      name: '후타바',          jp: 'ふたば',              group: '친구', rarity: 'U', color: '#EAF3E4', tone: '#7DBB6E', objects: ['potted plant', 'broccoli', 'apple', 'orange', 'vase'] },
  { id: 'anko',        name: '앙코',            jp: 'あんこ',              group: '친구', rarity: 'U', color: '#EFE6EF', tone: '#8E6B93', objects: ['handbag', 'suitcase', 'umbrella', 'tie', 'cookie', 'cake', 'rice ball'] },
  { id: 'rakko',       name: '랏코',            jp: 'ラッコ',              group: '친구', rarity: 'R', color: '#E9E1D3', tone: '#8C7A63', objects: ['knife', 'fork', 'spoon', 'sink', 'toothbrush', 'baseball bat', 'tennis racket', 'baseball glove'] },
  { id: 'kani',        name: '카니',            jp: 'カニ',                group: '친구', rarity: 'R', color: '#FBDDD5', tone: '#E8705C', objects: ['sink', 'toilet', 'hair drier', 'surfboard', 'skis', 'snowboard'] },
  { id: 'pajama',      name: '파자마 파티즈',   jp: 'パジャマパーティーズ', group: '친구', rarity: 'R', color: '#EEE9F7', tone: '#A9A0D6', objects: ['couch', 'teddy bear', 'clock', 'tv'] },
  { id: 'seiren',      name: '세이렌',          jp: 'セイレーン',          group: '친구', rarity: 'L', color: '#DDEDF2', tone: '#4FA3B5', objects: [], night: true },
  { id: 'yoroi_ramen', name: '라면 가게 갑옷',  jp: '鎧さん（ラーメン）',   group: '갑옷', rarity: 'R', color: '#DCDCE0', tone: '#6B6B75', objects: ['bowl', 'cup', 'spoon', 'fork', 'microwave', 'sink', 'bottle'] },
  { id: 'yoroi_info',  name: '안내소 갑옷',     jp: '鎧さん（案内所）',     group: '갑옷', rarity: 'R', color: '#DCDCE0', tone: '#6B6B75', objects: ['book', 'laptop', 'clock', 'cell phone', 'backpack', 'suitcase'] },
  { id: 'yoroi_kusa',  name: '풀뽑기 검정 갑옷', jp: '鎧さん（草むしり）',   group: '갑옷', rarity: 'R', color: '#DCDCE0', tone: '#6B6B75', objects: ['potted plant', 'scissors', 'broccoli', 'carrot', 'bench'] },
];
const SPRITES = SPECIES; // 기존 호출부 유지
const speciesById = (id) => SPECIES.find((s) => s.id === id);
const isNight = (d = new Date()) => d.getHours() >= 22 || d.getHours() < 5; // 심야 시크릿
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
  char: { state: 'hidden', since: 0, progress: 0, sprite: null, walking: false },
  // S7
  home: (() => { const h = store.get('home', null); if (h?.orient && !h.orient.abs) h.orient = null; return h; })(), // S8/S15: 상대 자이로값은 새 세션에서 무효
  // S8
  phase: store.get('home', null) ? 'play' : 'scan',
  scan: { start: 0, seen: {} },             // seen[label] = { n, maxW }
  near: 0,                                  // 0~1 대상 물체와의 가까움(bbox 폭 기준)
  playStart: 0, lastLockAt: 0,              // S14: 힌트 타이머
  edge: null,                               // S15: 마지막 엣지 힌트
  parallax: { x: 0, y: 0 },                 // S12: 스무딩된 화면 내 치우침 (-1~1)
  collection: store.get('collection', []).filter((c) => SPECIES.some((s) => s.id === c.id)),  // [{ id, label, at, night }] S13: 옛 별사탕 id는 버림
  hits: 0,                                  // 현재 락의 연속 매칭 횟수
  // S4
  segTimes: [], segBusy: false, lastSegAt: 0,
  mask: null,          // { w, h, alpha: Float32Array } EMA 마스크 (비디오 해상도)
  maskRejects: 0,
  // S5
  shots: 0,
};
window.__peekaboo = state;
state.placement = () => characterPlacement(performance.now()); // 디버그용

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
    if (state.missMs >= LOCK_LOST_MS) {
      rememberExitSide(lock); // S15
      state.lock = null; state.missMs = 0; state.hits = 0;
    }
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

// ---- S15: 카메라 방향(자이로) + 엣지 발광 힌트 ----
// DeviceOrientation(alpha, beta, gamma) → 후면 카메라가 보는 방향의 나침반 heading(북=0, 시계방향)과 pitch(위=+)
const orient = { ok: false, abs: false, heading: 0, pitch: 0 };
function cameraDir(alpha, beta, gamma) {
  const a = alpha * Math.PI / 180, b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  // R = Rz(a)·Rx(b)·Ry(g) 를 기기 -z(카메라 방향)에 적용. 세계축: x=동, y=북, z=위
  const x = ca * (-sg) - sa * (sb * cg), y = sa * (-sg) + ca * (sb * cg), z = -cb * cg;
  return { heading: Math.atan2(x, y) * 180 / Math.PI, pitch: Math.asin(Math.max(-1, Math.min(1, z))) * 180 / Math.PI };
}
function onOrient(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  const abs = e.type === 'deviceorientationabsolute' || e.absolute === true;
  if (orient.abs && !abs) return; // 절대값이 오면 상대값은 무시
  const d = cameraDir(e.alpha, e.beta, e.gamma);
  orient.ok = true; orient.abs = abs; orient.heading = d.heading; orient.pitch = d.pitch;
}
window.addEventListener('deviceorientationabsolute', onOrient);
window.addEventListener('deviceorientation', onOrient);
async function requestOrientation() { // iOS 13+는 사용자 제스처 안에서 권한 요청
  try { if (typeof DeviceOrientationEvent?.requestPermission === 'function') await DeviceOrientationEvent.requestPermission(); } catch {}
}
const wrapDeg = (d) => ((d + 540) % 360) - 180;

// 락이 풀릴 때 물체가 어느 가장자리로 나갔는지 기억(자이로가 없을 때의 대체 힌트)
function rememberExitSide(lock) {
  if (!state.home) return;
  const cx = (lock.box.x + lock.box.w / 2) / video.videoWidth, cy = (lock.box.y + lock.box.h / 2) / video.videoHeight;
  const dx = cx - 0.5, dy = cy - 0.5;
  state.home.lastSide = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom');
  store.set('home', state.home);
}
// 락 중엔 목표 방향을 갱신(1초마다 저장)
let lastOrientSave = 0;
function refreshTargetOrient(now) {
  if (!state.home || !orient.ok) return;
  state.home.orient = { heading: orient.heading, pitch: orient.pitch, abs: orient.abs };
  if (now - lastOrientSave > 1000) { lastOrientSave = now; store.set('home', state.home); }
}
// 화면 밖 목표를 향한 엣지 세기 {left,right,top,bottom} 0~1. 자이로 차이 우선, 없으면 마지막으로 나간 방향
function edgeHint() {
  const h = state.home; if (!h) return null;
  const o = h.orient;
  if (orient.ok && o && (o.abs === orient.abs || !o.abs)) {
    const dH = wrapDeg(o.heading - orient.heading), dP = o.pitch - orient.pitch;
    const k = (d) => Math.max(0, Math.min(1, (Math.abs(d) - EDGE_HINT_DEG) / (EDGE_FULL_DEG - EDGE_HINT_DEG)));
    const e = { left: dH < 0 ? k(dH) : 0, right: dH > 0 ? k(dH) : 0, top: dP > 0 ? k(dP) : 0, bottom: dP < 0 ? k(dP) : 0 };
    if (e.left || e.right || e.top || e.bottom) return { ...e, src: 'gyro' };
    return { left: 0, right: 0, top: 0, bottom: 0, src: 'gyro' }; // 방향은 맞는데 안 보임 → 엣지 없음
  }
  if (h.lastSide) return { left: 0, right: 0, top: 0, bottom: 0, [h.lastSide]: 0.6, src: 'side' };
  return null;
}
function drawEdgeHint(ctx, e, t) {
  const W = canvas.width, H = canvas.height, pulse = 0.8 + 0.2 * Math.sin(t / 350);
  const band = Math.min(W, H) * 0.22;
  const bar = (k, x0, y0, x1, y1, rx, ry, rw, rh, glyph, gx, gy) => {
    if (!k) return;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, `rgba(255,170,40,${0.85 * k * pulse})`); g.addColorStop(1, 'rgba(255,170,40,0)');
    ctx.fillStyle = g; ctx.fillRect(rx, ry, rw, rh);
    ctx.fillStyle = `rgba(255,255,255,${0.9 * k})`; ctx.font = `bold ${Math.round(band * 0.35)}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(glyph, gx, gy);
  };
  ctx.save();
  bar(e.left,   0, 0, band, 0,   0, 0, band, H,          '◀', band * 0.3, H / 2);
  bar(e.right,  W, 0, W - band, 0, W - band, 0, band, H, '▶', W - band * 0.3, H / 2);
  bar(e.top,    0, 0, 0, band,   0, 0, W, band,          '▲', W / 2, band * 0.3);
  bar(e.bottom, 0, H, 0, H - band, 0, H - band, W, band, '▼', W / 2, H - band * 0.3);
  ctx.restore();
}

// ---- S8: 공간 스캔 → 대상 물체 선택 ----
function startScan(now) {
  state.phase = 'scan'; state.scan = { start: now, seen: {} };
  state.lock = null; state.hits = 0; state.mask = null;
}
function recordScan(dets) {
  for (const d of dets) {
    if (!ALLOWED.includes(d.label) || d.score < LOCK_MIN_SCORE) continue;
    const s = state.scan.seen[d.label] ??= { n: 0, maxW: 0, sx: 0, sy: 0, sp: 0, no: 0 };
    s.n++; s.maxW = Math.max(s.maxW, d.w);
    if (orient.ok) { // S15: 이 물체를 봤을 때의 카메라 방향(원형 평균용 합)
      const h = orient.heading * Math.PI / 180;
      s.sx += Math.sin(h); s.sy += Math.cos(h); s.sp += orient.pitch; s.no++;
    }
  }
}
// 스캔 종료 조건: 최소 시간 경과 + 허용 물체 1개 이상. 그중 하나를 무작위로 골라 저장(플레이어에겐 비밀).
function maybeFinishScan(now) {
  if (state.phase !== 'scan') return;
  if (!state.scan.start) state.scan.start = now;
  const el = now - state.scan.start;
  const minHits = el >= SCAN_MAX_MS ? 1 : SCAN_MIN_HITS; // S14/S15: 오래 걸리면 완화
  const labels = Object.keys(state.scan.seen).filter((l) => state.scan.seen[l].n >= minHits);
  if (el < SCAN_MS || !labels.length) return;
  // S14: 본 횟수에 비례해 뽑는다(확실히 있는 물체가 대상이 될 확률이 높게)
  const total = labels.reduce((a, l) => a + state.scan.seen[l].n, 0);
  let r = Math.random() * total, label = labels[labels.length - 1];
  for (const l of labels) { r -= state.scan.seen[l].n; if (r <= 0) { label = l; break; } }
  const s = state.scan.seen[label];
  const orientAt = s.no ? { heading: Math.atan2(s.sx, s.sy) * 180 / Math.PI, pitch: s.sp / s.no, abs: orient.abs } : null; // S15
  state.home = { label, savedAt: Date.now(), seen: labels, orient: orientAt, lastSide: null };
  store.set('home', state.home);
  state.phase = 'play'; state.playStart = now; state.lastLockAt = 0;
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
  // S12: 물체 중심의 화면 내 치우침 → 패럴랙스 목표값, EMA로 부드럽게
  const p = state.parallax;
  const tx = L ? Math.max(-1, Math.min(1, ((L.box.x + L.box.w / 2) / video.videoWidth - 0.5) * 2)) : 0;
  const ty = L ? Math.max(-1, Math.min(1, ((L.box.y + L.box.h / 2) / video.videoHeight - 0.5) * 2)) : 0;
  p.x += (tx - p.x) * PARALLAX_SMOOTH; p.y += (ty - p.y) * PARALLAX_SMOOTH;
}
// S8: 물체 뒤 발광. 캐릭터보다 먼저 그리고, 그 위에 마스크로 잘라낸 물체 픽셀이 덮여 "뒤에서 새어 나오는" 빛이 된다.
// S16: 캐릭터가 나온 뒤(peek 이후)엔 0.6초에 걸쳐 15%로 사그라든다. 0=안 나옴, 1=완전히 나옴
function appeared(t) {
  const c = state.char;
  if (c.state === 'hidden' || c.state === 'charging') return 0;
  if (c.state === 'hide') return 1 - Math.min((t - c.since) / HIDE_MS, 1);
  return Math.min((t - c.since) / 600, 1) || (c.state !== 'peek' ? 1 : 0);
}
function drawGlow(ctx, b, t) {
  const c = state.char;
  const charging = c.state === 'charging' ? (t - c.since) / HOLD_MS : c.state === 'hidden' ? 0 : 1;
  const pulse = 0.5 + 0.5 * Math.sin(t / (charging ? 180 + 420 * (1 - charging) : 700)); // 충전 중엔 점점 빠르게 깜빡
  const focus = 1 - 0.85 * appeared(t); // S16
  const strength = (0.25 + 0.75 * state.near) * (0.6 + 0.4 * pulse) * (0.7 + 0.3 * charging) * focus;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const R = Math.max(b.w, b.h) * (0.7 + 0.5 * state.near + 0.2 * pulse);
  const g = ctx.createRadialGradient(cx, cy, R * 0.15, cx, cy, R);
  g.addColorStop(0, `rgba(255,236,150,${0.95 * strength})`);
  g.addColorStop(0.5, `rgba(255,210,90,${0.45 * strength})`);
  g.addColorStop(1, 'rgba(255,200,80,0)');
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2); ctx.restore();
  // S14: 밝은 배경에서는 'lighter'가 흰색으로 묻히므로, 일반 합성으로 주황 테두리 링을 더 그린다(마스크 아래라 물체 가장자리로 새어 나온다)
  if (b.w * b.h > canvas.width * canvas.height * 0.45) return; // S16: 화면을 거의 채우는 물체엔 링을 그리지 않는다(거대한 주황 띠가 됨)
  ctx.save();
  ctx.globalAlpha = 0.45 + 0.5 * strength;
  ctx.strokeStyle = '#ff9f1a'; ctx.lineWidth = Math.max(8, b.w * (0.07 + 0.07 * state.near));
  ctx.shadowColor = '#ffb020'; ctx.shadowBlur = Math.max(16, b.w * 0.25);
  // bbox보다 살짝 크게(0.66배 반지름) 그려서 물체 실루엣 바깥으로 테두리 빛이 보이게
  ctx.beginPath(); ctx.ellipse(cx, cy, b.w * (0.66 + 0.05 * pulse), b.h * (0.66 + 0.05 * pulse), 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
// S16: 스포트라이트 — 캐릭터 중심의 방사형 구멍을 뺀 나머지를 어둡게. 오클루전(물체 픽셀)은 이 위에 다시 그려지므로 물체는 밝게 남는다
function drawSpotlight(ctx, p, t) {
  const k = appeared(t); if (!k) return;
  const r = p.size / 2, cx = p.cx, cy = p.cy - r;
  const inner = p.size * 1.1, outer = p.size * 2.6;
  const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.55 * k})`);
  ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.restore();
}

// ---- S3/S7: 캐릭터 ----
const PEEK_MS = 2400, HIDE_MS = 300, WAVE_MS = 800, COLLECT_MS = 900; // S11: 2.4초에 걸쳐 스을쩍
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// S11: 0→0.3 살짝 나왔다가 → 0.18로 움찔 물러남 → 끝까지. 반환 {p, walking}
function sneakProgress(el) {
  const u = Math.min(el / PEEK_MS, 1);
  if (u < 0.3) return { p: 0.3 * easeOutCubic(u / 0.3), walking: true };
  if (u < 0.45) return { p: 0.3 - 0.12 * easeInOutCubic((u - 0.3) / 0.15), walking: false };
  return { p: 0.18 + 0.82 * easeInOutCubic((u - 0.45) / 0.55), walking: u < 1 };
}
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const confirmed = () => !!state.lock && state.hits >= CONFIRM_HITS; // S7: 타깃 확실

function isCollected(id) { return state.collection.some((c) => c.id === id); }

// S7 → S13: 등장할 종 고르기. 물체 라벨에 사는 종 중에서 희귀도 가중치로 뽑고, 미수집이 남았으면 70% 확률로 미수집 중에서.
// 라벨에 사는 종이 없으면 주역 3. 심야엔 세이렌이 어디서든 후보에 들어간다(가중치 1).
function pickSprite() {
  const label = state.lock?.label ?? state.home?.label;
  let pool = SPECIES.filter((sp) => !sp.night && sp.objects.includes(label));
  if (!pool.length) pool = SPECIES.filter((sp) => sp.group === '주역');
  if (isNight()) pool = pool.concat(SPECIES.filter((sp) => sp.night));
  const left = pool.filter((sp) => !isCollected(sp.id));
  if (left.length && Math.random() < 0.7) pool = left;
  const total = pool.reduce((a, sp) => a + RARITY[sp.rarity].w, 0);
  let r = Math.random() * total;
  for (const sp of pool) { r -= RARITY[sp.rarity].w; if (r <= 0) return sp; }
  return pool[pool.length - 1];
}
state.pickSprite = pickSprite; // 디버그용

// S13: 스킨 이미지. manifest.json에 적힌 id만 로드한다(없는 파일로 404를 내지 않기 위해).
const skinImages = {}; // id → HTMLImageElement | null
async function loadSkin() {
  if (params.get('skin') === 'none') return;
  try {
    const res = await fetch(SKIN.dir + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const ids = await res.json();
    for (const id of ids) {
      if (!speciesById(id)) continue;
      const img = new Image();
      img.onload = () => { skinImages[id] = img; };
      img.onerror = () => { skinImages[id] = null; };
      img.src = `${SKIN.dir}${id}.${SKIN.ext}`;
    }
  } catch (e) { console.warn('skin manifest', e); }
}
loadSkin();

// 상태 전이. progress 0=숨김(bbox.y+0.6h), 1=완전 등장(bbox.y+0.15h)
function updateCharacter(now) {
  const c = state.char;
  const locked = !!state.lock;
  if (!locked && c.state !== 'hidden' && c.state !== 'hide') {
    if (c.state === 'charging') { c.state = 'hidden'; c.progress = 0; } // 아직 안 나왔으면 바로 숨김
    else { c.state = 'hide'; c.since = now; }
  }
  if (confirmed() && (c.state === 'hidden' || c.state === 'hide')) { // S7: 확정되면 충전 시작
    c.sprite = pickSprite(); c.since = now; c.progress = 0;
    c.state = state.home?.solved ? 'peek' : 'charging'; // S10: 이미 맞춘 물체는 바로 짠!
  }
  const el = now - c.since;
  switch (c.state) {
    case 'charging': // S7: 5초 유지 → peek
      c.progress = 0;
      if (el >= HOLD_MS) {
        c.state = 'peek'; c.since = now;
        if (state.home && !state.home.solved) { state.home.solved = true; store.set('home', state.home); } // S10: 정답 확정
      }
      break;
    case 'peek': { // S11: 스을쩍 걸어 나오기
      const s = sneakProgress(el);
      c.progress = s.p; c.walking = s.walking;
      if (el >= PEEK_MS) { c.state = 'idle'; c.since = now; c.progress = 1; c.walking = false; }
      break;
    }
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

// S13: 캐릭터 그리기 진입점. 종에 공식 스킨이 있으면 이미지, 없으면 이름표 실루엣, 종이 없으면 예전 검댕이.
// opts: { sprite, collected, waving, collecting, collectT, tilt }
function drawCharacter(ctx, cx, cy, size, t, opts = {}) {
  const sp = opts.sprite;
  if (sp && skinImages[sp.id]) return drawSkin(ctx, skinImages[sp.id], cx, cy, size, t, opts);
  if (sp) return drawPlaceholder(ctx, sp, cx, cy, size, t, opts);
  return drawSoot(ctx, cx, cy, size, t, opts);
}
// 미수집 "!" 말풍선과 수집 반짝이. 세 렌더러가 공유한다.
function drawBadges(ctx, cx, bodyCy, r, size, t, opts) {
  if (opts.sprite && !opts.collected && !opts.collecting) {
    ctx.globalAlpha = 1;
    const bx = cx + r * 0.95, by = bodyCy - r * 1.25 + Math.sin(t / 300) * r * 0.05;
    ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.arc(bx, by, r * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#333'; ctx.font = `bold ${r * 0.3}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('!', bx, by + r * 0.01);
  }
  if (opts.collecting) {
    ctx.globalAlpha = 1 - Math.min(opts.collectT, 1);
    ctx.strokeStyle = opts.sprite?.tone ?? '#fff'; ctx.lineWidth = Math.max(2, size * 0.03);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, d0 = r * (1.2 + opts.collectT * 0.8), d1 = d0 + r * 0.25;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * d0, bodyCy + Math.sin(a) * d0); ctx.lineTo(cx + Math.cos(a) * d1, bodyCy + Math.sin(a) * d1); ctx.stroke();
    }
  }
}
// 공식 PNG 스킨. 투명 배경, 하단 중심 정렬. 폭을 size에 맞추고 뒤뚱거림·흔들기는 회전으로.
function drawSkin(ctx, img, cx, cy, size, t, opts) {
  const r = size / 2, bodyCy = cy - r;
  const w = size * 1.1, h = w * (img.naturalHeight / img.naturalWidth);
  const wobble = (opts.waving ? Math.sin(t / 60) * 0.08 : 0) + (opts.tilt ?? 0);
  ctx.save();
  ctx.globalAlpha = 1; // S16: 미수집도 불투명(구분은 '!' 말풍선)
  ctx.translate(cx, cy); ctx.rotate(wobble); ctx.translate(-cx, -cy);
  ctx.drawImage(img, cx - w / 2, cy - h, w, h);
  drawBadges(ctx, cx, bodyCy, r, size, t, opts);
  ctx.restore();
}
// 공식 에셋이 아직 없을 때의 자리 표시. 종의 색과 이름표만 있고 특정 캐릭터의 생김새는 흉내 내지 않는다.
function drawPlaceholder(ctx, sp, cx, cy, size, t, opts) {
  const r = size / 2, bodyCy = cy - r;
  const blink = (t % 3400) < 110;
  const wobble = (opts.waving ? Math.sin(t / 60) * 0.08 : 0) + (opts.tilt ?? 0);
  ctx.save();
  ctx.globalAlpha = 1; // S16: 미수집도 불투명(구분은 '!' 말풍선)
  ctx.translate(cx, bodyCy); ctx.rotate(wobble); ctx.translate(-cx, -bodyCy);
  ctx.fillStyle = sp.color; ctx.strokeStyle = '#3B322C'; ctx.lineWidth = Math.max(3, size * 0.05); // S16: 윤곽 굵게
  ctx.beginPath(); ctx.ellipse(cx, bodyCy, r, r * 0.95, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = sp.tone; // 볼
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * r * 0.55, bodyCy + r * 0.12, r * 0.17, r * 0.11, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#3B322C'; // 점 눈
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * r * 0.3, bodyCy - r * 0.08, r * 0.06, blink ? r * 0.012 : r * 0.07, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = '#3B322C'; ctx.lineWidth = Math.max(1.5, size * 0.02); ctx.lineCap = 'round'; // ω 입
  ctx.beginPath(); ctx.arc(cx - r * 0.06, bodyCy + r * 0.22, r * 0.06, 0, Math.PI); ctx.arc(cx + r * 0.06, bodyCy + r * 0.22, r * 0.06, 0, Math.PI); ctx.stroke();
  // 이름표
  ctx.font = `bold ${Math.max(10, r * 0.26)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(sp.name).width + r * 0.4, th = r * 0.36, ty = cy + th * 0.7;
  ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.beginPath(); ctx.roundRect(cx - tw / 2, ty - th / 2, tw, th, th / 2); ctx.fill();
  ctx.fillStyle = '#3B322C'; ctx.fillText(sp.name, cx, ty + 1);
  drawBadges(ctx, cx, bodyCy, r, size, t, opts);
  ctx.restore();
}
// S7: 검댕이 — 까만 털뭉치 몸 + 큰 흰 눈. (cx, cy)=하단 중심, size=폭. S13 이후엔 종이 없을 때만 쓴다.
function drawSoot(ctx, cx, cy, size, t, opts = {}) {
  const r = size / 2;
  const bodyCy = cy - r;
  const blink = (t % 3400) < 110;
  const wobble = (opts.waving ? Math.sin(t / 60) * 0.08 : 0) + (opts.tilt ?? 0); // S11: 걷는 뒤뚱거림
  ctx.save();
  ctx.globalAlpha = 1; // S16: 미수집도 불투명
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

// S7: 충전 연출 — 등장 지점 주변으로 검댕 알갱이가 떠오르고 진행 호. S10: 등장 지점(p)은 위/옆 모두 대응
function drawCharging(ctx, p, t, k) {
  ctx.save();
  const b = p.box, s = p.size;
  // 등장 지점: 위쪽이면 bbox 상단 중앙, 옆이면 그 옆 가장자리의 중간 높이
  const ox = p.side === 'top' ? b.x + b.w / 2 : p.side === 'right' ? b.x + b.w : b.x;
  const oy = p.side === 'top' ? b.y : Math.min(Math.max(b.y + b.h * 0.55, 0), canvas.height);
  const range = s * 0.7;
  for (let i = 0; i < 8; i++) {
    const phase = ((t / 7 + i * 61) % range);
    const x = ox + (i - 3.5) * s * 0.13 + Math.sin(t / 450 + i) * s * 0.04;
    const y = oy - phase;
    ctx.globalAlpha = k * (1 - phase / range) * 0.9;
    ctx.fillStyle = '#1b1b1b';
    ctx.beginPath(); ctx.arc(x, y, s * (0.015 + 0.015 * k), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 0.9;
  const ry = oy - s * 0.25;
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = Math.max(2, s * 0.025);
  ctx.beginPath(); ctx.arc(ox, ry, s * 0.2, -Math.PI / 2, Math.PI * 1.5); ctx.stroke();
  ctx.strokeStyle = '#ffd54f';
  ctx.beginPath(); ctx.arc(ox, ry, s * 0.2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke();
  ctx.restore();
}

// S16: 패럴랙스·옆 배치로 캐릭터가 화면 밖으로 밀리지 않게 x를 화면 안으로 제한
const clampX = (x, size) => Math.max(size * 0.65, Math.min(canvas.width - size * 0.65, x));
// 캐릭터의 현재 화면 배치 (하단 중심 x, y, 폭, side). 락이 없으면 null.
// S10: 위쪽 여유가 없으면(큰 물체·화면 상단) 여유가 더 많은 옆쪽에서 나온다. 크기는 화면 폭의 45%로 제한.
function characterPlacement(t) {
  const b = lockedScreenBox(); if (!b) return null;
  const c = state.char;
  const dpr = canvas.width / canvas.clientWidth;
  let size = Math.min(b.w * 0.8, canvas.width * 0.45);
  const topMargin = 60 * dpr;                      // 몸통 윗변이 이 아래에 있으면 OK (털·말풍선은 HUD와 겹쳐도 됨)
  const topRoom = b.y + b.h * 0.15 - size;         // 완전 등장 시 몸통 윗변
  let side = 'top';
  if (topRoom < topMargin) {
    const leftRoom = b.x, rightRoom = canvas.width - (b.x + b.w);
    const room = Math.max(leftRoom, rightRoom);
    if (room >= 70 * dpr) {
      side = rightRoom >= leftRoom ? 'right' : 'left';
      size = Math.min(size, room / 1.0); // 등장 시 몸(85%)+털이 화면 안에 들어오도록
    }
  }
  let bob = c.state === 'idle' ? Math.sin(t / 400) * 2 * dpr : 0;
  if (c.state === 'wave') bob = -Math.abs(Math.sin((t - c.since) / WAVE_MS * Math.PI * 2)) * 0.12 * Math.min(b.h, size * 2); // S5: 점프
  if (c.state === 'collect') bob = -Math.abs(Math.sin((t - c.since) / COLLECT_MS * Math.PI)) * 0.2 * Math.min(b.h, size * 2); // S7: 큰 점프
  if (c.state === 'peek' && c.walking) bob = -Math.abs(Math.sin((t - c.since) / 85)) * size * 0.035; // S11: 걷는 들썩임
  // S12: 패럴랙스 — 물체가 화면 왼쪽에 있으면(카메라가 오른쪽으로 이동) 캐릭터는 오른쪽으로, 물체가 아래쪽이면(위에서 봄) 위로
  const px = -state.parallax.x * b.w * PARALLAX_X * c.progress;
  const py = -Math.max(0, state.parallax.y) * b.h * PARALLAX_Y * c.progress;
  if (side === 'top') {
    // S11: 숨김 위치는 털까지 bbox 상단 아래로(가능하면 완전히 가려짐). S12: 등장해도 반쯤(0.45h) 숨어 있고 패럴랙스로 더 드러남
    const hiddenY = Math.min(Math.max(b.y + b.h * 0.6, b.y + size * 1.2), b.y + b.h + size * 0.2);
    const shownY = b.y + b.h * 0.45;
    const anchorY = Math.max(hiddenY + (shownY - hiddenY) * c.progress + py, topMargin + size) + bob;
    return { cx: clampX(b.x + b.w / 2 + px, size), cy: anchorY, size, side, box: b };
  }
  // 옆: 숨김 = 털까지 bbox 안쪽(가려짐), 등장 = 몸의 55%가 bbox 밖으로. 패럴랙스로 더 드러남
  const dir = side === 'right' ? 1 : -1;
  const edge = side === 'right' ? b.x + b.w : b.x;
  const cx = clampX(edge + dir * (-size * 0.7 + size * 0.75 * c.progress) + px, size);
  const cy = Math.min(Math.max(b.y + b.h * 0.55, topMargin + size), canvas.height - size * 0.3) + size / 2 + bob + py;
  return { cx, cy, size, side, box: b };
}

// S3: 합성 — (1) video → (2) 캐릭터 → (3) video의 락 bbox 영역 재도장(사각 오클루전)
function composite(t) {
  const { s, ox, oy, vw, vh } = coverTransform();
  ctx.drawImage(video, ox, oy, vw * s, vh * s);
  updateCharacter(t);
  const p = characterPlacement(t);
  const c = state.char;
  updateNear(); // S8
  if (state.lock) state.lastLockAt = t; // S14
  if (p && state.phase === 'play') { drawGlow(ctx, p.box, t); refreshTargetOrient(t); state.edge = null; } // S8: 물체 뒤 발광 (캐릭터·오클루전보다 먼저). S15: 방향 갱신
  if (!p && state.phase === 'play') { const e = edgeHint(); if (e) { state.edge = e; drawEdgeHint(ctx, e, t); } } // S15: 화면 밖이면 엣지 발광
  if (p && c.state !== 'hidden' && c.state !== 'charging') drawSpotlight(ctx, p, t); // S16: 캐릭터 주변만 밝게
  if (p && c.state !== 'hidden' && c.state !== 'charging') {
    drawCharacter(ctx, p.cx, p.cy, p.size, t, { // S7
      sprite: c.sprite, collected: c.sprite && isCollected(c.sprite.id) && c.state !== 'collect',
      waving: c.state === 'wave', collecting: c.state === 'collect', collectT: (t - c.since) / COLLECT_MS,
      tilt: c.state === 'peek' && c.walking ? Math.sin((t - c.since) / 85) * 0.07 : 0, // S11
    });
    if (!(USE_MASK && occludeWithMask(s, ox, oy, vw, vh))) occlude(p, s, ox, oy, vw, vh); // S4 → S3 폴백
  }
  if (p && c.state === 'charging') drawCharging(ctx, p, t, Math.min((t - c.since) / HOLD_MS, 1)); // S7
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
  if (video.videoWidth) { composite(t); if (params.get('debug') === '1') drawDetections(t); } // S3 → S16: 박스는 ?debug=1일 때만
  updateHint(); // S5
  hud.textContent =
    `det ${hz(state.detTimes, t)} Hz | seg ${hz(state.segTimes, t)} Hz | fps ${hz(state.frameTimes, t)} | ${state.delegate}\n` +
    `video ${video.videoWidth}x${video.videoHeight}\n` +
    `lock ${state.lock ? state.lock.label : '-'} | miss ${(state.missMs / 1000).toFixed(1)}s | char ${state.char.state}\n` +
    `mask ${USE_MASK ? (state.mask ? 'on' : 'none') : 'off'} | rej ${state.maskRejects}\n` +
    `phase ${state.phase} | home ${state.home?.label ?? '-'}${state.home?.solved ? '✓' : ''} | near ${state.near.toFixed(2)} | hits ${state.hits}\n` +
    `sprite ${state.char.sprite?.id ?? '-'}${isNight() ? ' night' : ''} | col ${state.collection.length}/${SPECIES.length} | px ${state.parallax.x.toFixed(2)} py ${state.parallax.y.toFixed(2)}\n` +
    `gyro ${orient.ok ? (orient.abs ? 'abs ' : 'rel ') + orient.heading.toFixed(0) + '°/' + orient.pitch.toFixed(0) + '°' : '-'} | target ${state.home?.orient ? state.home.orient.heading.toFixed(0) + '°/' + state.home.orient.pitch.toFixed(0) + '°' : '-'} | edge ${state.edge ? ['left','right','top','bottom'].filter((k) => state.edge[k]).join(',') || 'none' : '-'}` +
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
    state.collection.push({ id: c.sprite.id, label: state.lock?.label ?? '?', at: Date.now(), night: isNight() });
    store.set('collection', state.collection);
    c.state = 'collect'; c.since = performance.now();
    renderBadge();
  } else { c.state = 'wave'; c.since = performance.now(); }
}
canvas.addEventListener('pointerdown', onTap);

// S13: 공유 사진에 종 이름·희귀도 스탬프(자랑 장치). 캐릭터가 나와 있을 때만.
function stampedCanvas() {
  const c = state.char, sp = c.sprite;
  if (!sp || !['idle', 'wave', 'collect'].includes(c.state)) return canvas;
  const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
  const g = out.getContext('2d'); g.drawImage(canvas, 0, 0);
  const dpr = canvas.width / canvas.clientWidth, fs = 15 * dpr, pad = 10 * dpr;
  const text = `${sp.name} · ${RARITY[sp.rarity].name}${isNight() ? ' · 심야' : ''}  #Peekaboo`;
  g.font = `bold ${fs}px system-ui, sans-serif`; g.textBaseline = 'middle';
  const w = g.measureText(text).width + pad * 2, h = fs * 2, x = pad, y = canvas.height - h - pad * 3;
  g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.roundRect(x, y, w, h, h / 2); g.fill();
  g.fillStyle = '#fff'; g.fillText(text, x + pad, y + h / 2);
  return out;
}
// 셔터: 캔버스 → JPEG → Web Share API, 안 되면 다운로드
async function shoot() {
  shutterBtn.disabled = true;
  try {
    const blob = await new Promise((r) => stampedCanvas().toBlob(r, 'image/jpeg', 0.9));
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
    const left = Math.max(0, Math.ceil((SCAN_MS - (performance.now() - state.scan.start)) / 1000));
    text = n ? `주변을 천천히 둘러보세요 (${left}초)… 물체 ${n}개 발견` : `주변을 천천히 둘러보세요 (${left}초)`;
  }
  else if (!state.lock) { // S14: 후보 목록 + 오래 못 찾으면 라벨 힌트
    const seen = state.home?.seen ?? [];
    const base = isNight() ? '심야에는 세이렌이 나올지도…' : '이 공간 어딘가에 먼작귀가 숨어 있어요.';
    const cand = seen.length > 1 ? ` 스캔에서 본 ${seen.length}개(${seen.join(', ')}) 중 하나예요.` : '';
    const waited = performance.now() - Math.max(state.playStart, state.lastLockAt);
    const e = state.edge, dirOn = e && (e.left || e.right || e.top || e.bottom);
    const hint = state.home && waited > HINT_AFTER_MS ? ` 힌트: ${state.home.label} 근처를 비춰보세요`
      : dirOn ? ' 빛나는 가장자리 쪽으로 카메라를 돌려보세요' : ' 빛나는 물건을 찾아보세요';
    text = base + cand + hint;
  }
  else if (c.state === 'hidden' || c.state === 'hide') text = state.home?.solved ? '' : state.near < 0.5 ? '빛이 보여요! 더 가까이…' : '여기다! 가만히 비춰보세요';
  else if (c.state === 'charging') text = `뭔가 나올 것 같아… (${Math.max(0, Math.ceil((HOLD_MS - (performance.now() - c.since)) / 1000))})`;
  else if (c.state === 'idle' && c.sprite && !isCollected(c.sprite.id)) text = `${c.sprite.name}! 탭해서 잡기`;
  else if (c.state === 'idle' && c.sprite) text = `${c.sprite.name} (이미 도감에 있음)`;
  if (msg.textContent !== text) msg.textContent = text;
}

// ---- S7: 도감 UI ----
const badge = document.getElementById('badge');
const panel = document.getElementById('panel');
function renderBadge() { badge.textContent = `★ ${state.collection.length}/${SPECIES.length}`; }
// S13: 세트(주역·친구·갑옷)별 그리드. 미수집은 실루엣 + "???" + 희귀도, 심야 종은 힌트. 세트를 다 채우면 표시.
function renderPanel() {
  const slots = panel.querySelector('#slots');
  slots.innerHTML = '';
  for (const setName of SETS) {
    const members = SPECIES.filter((sp) => sp.group === setName);
    const n = members.filter((sp) => isCollected(sp.id)).length;
    const group = document.createElement('div'); group.className = 'group';
    const h = document.createElement('h3');
    h.innerHTML = `${setName} <small>${n} / ${members.length}</small>` + (n === members.length ? ' <em>세트 완성</em>' : '');
    group.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'grid';
    for (const sp of members) {
      const got = state.collection.find((c) => c.id === sp.id);
      const el = document.createElement('div'); el.className = 'slot' + (got ? ' got' : '');
      el.style.setProperty('--rar', RARITY[sp.rarity].color);
      const cv = document.createElement('canvas'); cv.width = cv.height = 96;
      const g = cv.getContext('2d');
      if (got) drawCharacter(g, 48, 84, 52, 1000, { sprite: sp, collected: true });
      else {
        g.fillStyle = '#c9c2b6'; g.beginPath(); g.ellipse(48, 58, 26, 25, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff'; g.font = 'bold 18px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 48, 60);
      }
      el.appendChild(cv);
      const cap = document.createElement('div');
      cap.textContent = got ? `${sp.name} · ${got.label}${got.night ? ' · 심야' : ''}` : (sp.night ? `??? · 심야에만` : `??? · ${RARITY[sp.rarity].name}`);
      el.appendChild(cap); grid.appendChild(el);
    }
    group.appendChild(grid); slots.appendChild(group);
  }
  panel.querySelector('#home').textContent = state.home
    ? `숨은 곳: ${state.home.solved ? state.home.label + ' (맞춤!)' : '??? (빛나는 물건을 찾아보세요)'} · 스캔에서 본 물체: ${(state.home.seen ?? [state.home.label]).join(', ')}`
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
  await requestOrientation(); // S15
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
    else state.playStart = performance.now(); // S14
    video.requestVideoFrameCallback(onVideoFrame);
  } catch (e) {
    console.error(e);
    state.error = e.message || String(e);
    msg.textContent = `오류: ${state.error}\n(HTTPS·카메라 권한을 확인하세요)`;
  }
}

requestAnimationFrame(render);
startBtn.addEventListener('click', main, { once: true });

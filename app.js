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
// S21: 숨바꼭질 포맷 — 숨기는 사람이 특정 장소의 특정 물체에 캐릭터를 숨기고(GPS+나침반+물체 라벨을 링크에 담아 공유), 찾는 사람은 링크를 열어 거리·방향 안내를 따라간 뒤 그 물체를 비춰 잡는다. 서버 없음
// S20: 픽셀 캐릭터 — 원본 에셋이 없을 때의 기본 그림을 다마고치 문법의 22×24 픽셀 스프라이트(pixel.js)로. ?skin=drawn 이면 S17 캔버스 드로잉, ?skin=silhouette 이면 실루엣
// S19: 원본 에셋을 기기에서 직접 넣기 — 도감 패널의 파일 선택으로 <id>.png / <id>_wave.png 를 IndexedDB에 저장. 저장소에 올리지 않아도 폰에서 바로 원본이 뜬다
// S18: 원본(공식) 에셋 우선 — manifest 항목에 file/scale/dy/wave 지정 가능, wave 전용 그림 지원, 파일이 있으면 캔버스 드로잉은 쓰지 않는다
// S17: 실제 등장 캐릭터 기준으로 도감 정정(14종)하고, 종마다 캔버스로 알아볼 수 있게 그린다(drawSpecies). ?skin=silhouette 이면 예전 실루엣
// S16: 등장 후엔 캐릭터에 집중 — 발광은 사그라들고, 캐릭터 주변만 밝은 스포트라이트(나머지 어둡게), 캐릭터는 불투명, 검출 박스는 ?debug=1일 때만
// S15: 타깃 못 잡는 문제 — 스캔은 딱 5초, 그동안 본 물체 중에서만 선정. 자이로로 물체 방향을 기억해 화면 밖이면 상하좌우 엣지 발광으로 카메라를 유도
// S14: 못 찾는 문제 대응 — 스캔에서 충분히(4회↑) 본 물체만 후보, 본 횟수 가중 선택, 후보 목록·20초 뒤 라벨 힌트, 밝은 배경에서도 보이는 발광 링
// S13: 먼작귀 도감 — 별사탕 6색 대신 캐릭터 15종. 물체 라벨마다 사는 종이 다르고, 희귀도·심야 시크릿·세트가 있다. 그림은 공식 에셋 슬롯(assets/skins/chiikawa/)이며 없으면 이름표 실루엣

import { drawPixel } from './pixel.js'; // S20

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
// S21: 숨바꼭질
const NEAR_M = 25;            // 숨긴 지점에서 이 거리(또는 GPS 오차 합) 안이면 "근처" → 물체 찾기 시작
const GEO_BYPASS_MS = 20000;  // GPS가 이만큼 안 잡히거나 오차가 크면 "GPS 없이 찾기" 허용
const NEAR_MIN = 0.15, NEAR_MAX = 0.6; // bbox 폭/영상 폭 → 0(멀다)~1(가깝다)
// S12: 패럴랙스. 물체가 화면 중앙에서 얼마나 치우쳤는지(-1~1)를 카메라 이동의 근사치로 쓴다.
const PARALLAX_X = 0.55;   // 가로 최대 이동 = bbox 폭 × 이 값
const PARALLAX_Y = 0.35;   // 세로 최대 이동 = bbox 높이 × 이 값 (위에서 내려다볼 때)
const PARALLAX_SMOOTH = 0.12;
// S13: 먼작귀 도감. 이름은 팬 위키 기준 가칭이며 라이선스 시 공식 캐릭터 시트로 교체한다(docs/preview/chiikawa-lab.html).
// objects = 이 종이 사는 물체(COCO 라벨). 비어 있으면 어디서도 안 나오고 night 종은 심야(22~05시)에만 어디서든 낮은 확률로 나온다.
const SKIN = { id: 'chiikawa', dir: './assets/skins/chiikawa/', ext: 'png' }; // <dir>/manifest.json 에 적힌 id의 원본 그림을 그린다. 없으면 캔버스 드로잉(S17)
const RARITY = {
  C: { name: '흔함', w: 10, color: '#B8B2A8' },
  U: { name: '보통', w: 5,  color: '#5FA36E' },
  R: { name: '희귀', w: 2,  color: '#4A8DE0' },
  L: { name: '전설', w: 1,  color: '#E0A020' },
};
const SETS = ['주역', '친구', '갑옷'];
const SPECIES = [
  // S17: 원작·팬위키 기준 정리. objects = 이 종이 사는 물체(COCO 라벨). night 종은 22~05시에만.
  { id: 'chiikawa',      name: '치이카와',      jp: 'ちいかわ',              group: '주역', rarity: 'C', color: '#FFFFFF', tone: '#F7B6C2', objects: ['cup', 'bowl', 'bottle', 'teddy bear', 'book', 'backpack', 'chair', 'handbag'] },
  { id: 'hachiware',     name: '하치와레',      jp: 'ハチワレ',              group: '주역', rarity: 'C', color: '#FFFFFF', tone: '#7FB3E6', objects: ['book', 'laptop', 'keyboard', 'cell phone', 'remote', 'tv', 'scissors', 'mouse'] },
  { id: 'usagi',         name: '우사기',        jp: 'うさぎ',                group: '주역', rarity: 'C', color: '#FFF2A8', tone: '#F5D26B', objects: ['potted plant', 'sports ball', 'frisbee', 'kite', 'banana', 'carrot', 'skateboard', 'umbrella'] },
  { id: 'momonga',       name: '모몽가',        jp: 'モモンガ',              group: '친구', rarity: 'U', color: '#FFFFFF', tone: '#F4B8D0', objects: ['laptop', 'mouse', 'keyboard', 'tv', 'clock', 'vase'] },
  { id: 'kurimanju',     name: '쿠리만쥬',      jp: 'くりまんじゅう',        group: '친구', rarity: 'U', color: '#F6E7B8', tone: '#8E5A2B', objects: ['bottle', 'wine glass', 'cup', 'couch', 'refrigerator', 'pizza', 'hot dog', 'sandwich'] },
  { id: 'shisa',         name: '시사',          jp: 'シーサー',              group: '친구', rarity: 'U', color: '#F3C24B', tone: '#E8742C', objects: ['chair', 'bench', 'microwave', 'oven', 'toaster', 'donut', 'cake'] },
  { id: 'rakko',         name: '랏코',          jp: 'ラッコ',                group: '친구', rarity: 'R', color: '#8B6A4E', tone: '#E9D9C3', objects: ['knife', 'fork', 'spoon', 'sink', 'toothbrush', 'baseball bat', 'tennis racket', 'baseball glove'] },
  { id: 'furuhonya',     name: '헌책방(카니짱)', jp: '古本屋',                group: '친구', rarity: 'R', color: '#F6B7C6', tone: '#E07A93', objects: ['book', 'scissors', 'vase', 'clock', 'suitcase'] },
  { id: 'dekatsuyo',     name: '데카츠요',      jp: 'でかつよ',              group: '친구', rarity: 'R', color: '#FFFFFF', tone: '#F7B6C2', objects: ['sports ball', 'baseball bat', 'skateboard', 'bench', 'chair', 'suitcase', 'surfboard'] },
  { id: 'pajama',        name: '파자마 파티즈', jp: 'パジャマパーティーズ',  group: '친구', rarity: 'R', color: '#FFFFFF', tone: '#A9A0D6', objects: ['couch', 'teddy bear', 'clock', 'tv'] },
  { id: 'seiren',        name: '세이렌',        jp: 'セイレーン',            group: '친구', rarity: 'L', color: '#F3EFE4', tone: '#5FB3C4', objects: [], night: true },
  { id: 'yoroi_ramen',   name: '라면 가게 갑옷', jp: '鎧さん（ラーメン）',     group: '갑옷', rarity: 'R', color: '#F2C94C', tone: '#FFFFFF', objects: ['bowl', 'cup', 'spoon', 'fork', 'microwave', 'sink', 'bottle'] },
  { id: 'yoroi_info',    name: '안내소 갑옷',   jp: '鎧さん（案内所）',       group: '갑옷', rarity: 'R', color: '#C9CDD6', tone: '#8A9099', objects: ['book', 'laptop', 'clock', 'cell phone', 'backpack', 'potted plant'] },
  { id: 'yoroi_pochette', name: '포셰트 갑옷',  jp: '鎧さん（ポシェット）',   group: '갑옷', rarity: 'R', color: '#5B8DD9', tone: '#8B5E3C', objects: ['handbag', 'backpack', 'umbrella', 'suitcase', 'tie'] },
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
const startBtn = document.getElementById('start'); // (S21: 메뉴로 대체, 호환용)

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
  // S21
  mode: 'scan',                             // 'hide' | 'seek' | 'scan'
  cache: null,                              // seek: 링크에서 읽은 숨김 정보
  geo: null, dist: null, bearing: null,     // 현재 위치, 숨긴 지점까지 거리(m), 방위(북 기준 시계방향)
  geoBypass: false, geoStart: 0,
  hides: store.get('hides', []),            // 내가 숨긴 것들
  finds: store.get('finds', []),            // 내가 찾은 cache id
  scan: { start: 0, seen: {} },             // seen[label] = { n, maxW }
  near: 0,                                  // 0~1 대상 물체와의 가까움(bbox 폭 기준)
  playStart: 0, lastLockAt: 0,              // S14: 힌트 타이머
  edge: null,                               // S15: 마지막 엣지 힌트
  skins: null,                              // S18: 로드된 원본 에셋 id 목록
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
state.drawCharacter = (...a) => drawCharacter(...a); state.SPECIES = SPECIES; // 디버그용(도감 시트 렌더)

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
      // S7/S8/S21: 숨기기 모드는 아무 물체나, 찾기/스캔 모드는 대상 클래스만(찾기는 근처에 왔을 때만)
      const ok = state.mode === 'hide' ? ALLOWED.includes(d.label) : (state.home && !seekFar()) ? d.label === state.home.label : false;
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

// ---- S21: 숨바꼭질 — 링크 인코딩, GPS, 거리·방위 ----
const b64u = {
  enc: (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))),
};
function encodeCache(c) { return b64u.enc(JSON.stringify(c)); }
function decodeCache(s) { try { const c = JSON.parse(b64u.dec(s)); return c && c.v === 1 && c.label && c.sp ? c : null; } catch { return null; } }
function cacheUrl(c) { const u = new URL(location.href); u.search = ''; u.searchParams.set('c', encodeCache(c)); return u.toString(); }
function startGeo() {
  if (!navigator.geolocation) return;
  state.geoStart = performance.now();
  navigator.geolocation.watchPosition((p) => {
    state.geo = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy ?? 999 };
    updateDistance();
  }, (e) => console.warn('geo', e.message), { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
}
const toRad = (d) => d * Math.PI / 180;
function haversine(a, b) {
  const R = 6371000, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearingTo(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function updateDistance() {
  const c = state.cache, g = state.geo;
  if (!c || !g || c.lat == null) { state.dist = null; state.bearing = null; return; }
  state.dist = haversine(g, c); state.bearing = bearingTo(g, c);
}
// 찾기 모드에서 아직 멀리 있나? (GPS 없이 찾기를 누르면 false)
function seekFar() {
  if (state.mode !== 'seek' || state.geoBypass) return false;
  const c = state.cache; if (!c || c.lat == null) return false;
  if (state.dist == null) return true;
  return state.dist > Math.max(NEAR_M, (state.geo?.acc ?? 0) + (c.acc ?? 0));
}
function geoStuck() { // GPS가 안 잡히거나 오차가 커서 우회를 권할 상황
  return state.mode === 'seek' && !state.geoBypass && performance.now() - state.geoStart > GEO_BYPASS_MS && (state.dist == null || (state.geo?.acc ?? 999) > 100);
}
// 숨기기: 현재 락된 물체 + 위치 + 방향 + 캐릭터로 cache 생성
function makeCache() {
  const L = state.lock; if (!L) return null;
  const sp = pickSpriteForHide(L.label);
  const c = { v: 1, id: Math.random().toString(36).slice(2, 8), label: L.label, sp: sp.id, at: Date.now() };
  if (state.geo) { c.lat = +state.geo.lat.toFixed(6); c.lng = +state.geo.lng.toFixed(6); c.acc = Math.round(state.geo.acc); }
  if (orient.ok && orient.abs) { c.heading = Math.round(orient.heading); c.pitch = Math.round(orient.pitch); }
  return c;
}
function pickSpriteForHide(label) {
  let pool = SPECIES.filter((sp) => !sp.night && sp.objects.includes(label));
  if (!pool.length) pool = SPECIES.filter((sp) => !sp.night);
  return pool[Math.floor(Math.random() * pool.length)];
}
// 찾기: cache → home
function beginSeek(c) {
  state.mode = 'seek'; state.cache = c; state.phase = 'play';
  state.home = { label: c.label, seen: [c.label], savedAt: c.at, solved: state.finds.includes(c.id), cacheId: c.id,
    orient: c.heading != null ? { heading: c.heading, pitch: c.pitch ?? 0, abs: true } : null };
  state.playStart = performance.now(); state.lastLockAt = 0;
  updateDistance();
}
// 찾기 모드 안내 배너(거리·화살표)
const seekbar = document.getElementById('seekbar');
function renderSeekbar() {
  const on = state.mode === 'seek' && detector && (seekFar() || geoStuck());
  seekbar.hidden = !on; if (!on) return;
  const d = state.dist;
  let txt = d == null ? 'GPS 잡는 중…' : d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
  if (state.geo?.acc > 50) txt += ` (오차 ±${Math.round(state.geo.acc)}m)`;
  seekbar.querySelector('#dist').textContent = txt;
  const ar = seekbar.querySelector('#arrow');
  if (state.bearing != null && orient.ok) { ar.hidden = false; ar.style.transform = `rotate(${wrapDeg(state.bearing - orient.heading)}deg)`; }
  else ar.hidden = true;
  seekbar.querySelector('#bypass').hidden = !geoStuck();
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
  if (state.cache) return speciesById(state.cache.sp) ?? SPECIES[0]; // S21: 숨긴 사람이 정한 캐릭터
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

// S13/S18: 원본 에셋. manifest.json에 적힌 항목만 로드한다(없는 파일로 404를 내지 않기 위해).
// 항목은 "id" 문자열 또는 { id, file?, scale?, dy?, wave? }:
//   file  = 파일명(기본 <id>.png), wave = 손 흔들 때 그림(기본 <id>_wave.png 가 있으면 자동), scale = 폭 배율(기본 1.1), dy = 하단 기준 세로 오프셋(폭 대비, 기본 0)
const skinImages = {}; // id → { img, wave, scale, dy } | null
function loadImage(src) { return new Promise((res) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = src; }); }
async function loadSkin() {
  if (params.get('skin') === 'none' || params.get('skin') === 'silhouette') return;
  try {
    const res = await fetch(SKIN.dir + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const list = await res.json();
    for (const entry of list) {
      const e = typeof entry === 'string' ? { id: entry } : entry;
      if (!e?.id || !speciesById(e.id)) continue;
      const img = await loadImage(SKIN.dir + (e.file ?? `${e.id}.${SKIN.ext}`));
      if (!img) { skinImages[e.id] = null; console.warn('skin missing', e.id); continue; }
      const wave = e.wave === false ? null : await loadImage(SKIN.dir + (e.wave ?? `${e.id}_wave.${SKIN.ext}`));
      skinImages[e.id] = { img, wave, scale: e.scale ?? 1.1, dy: e.dy ?? 0 };
    }
    state.skins = Object.keys(skinImages).filter((k) => skinImages[k]);
  } catch (e) { console.warn('skin manifest', e); }
}
loadSkin().then(loadLocalSkins);

// ---- S19: 기기 저장 원본 에셋 (IndexedDB) ----
const DB_NAME = 'peekaboo', DB_STORE = 'skins';
function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
}
async function dbAll() {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readonly'), st = tx.objectStore(DB_STORE), out = {};
    const req = st.openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
    req.onerror = () => rej(req.error);
  });
}
async function dbPut(entries) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite'), st = tx.objectStore(DB_STORE);
    for (const [k, v] of entries) st.put(v, k);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function dbClear() {
  const db = await openDb();
  return new Promise((res, rej) => { const tx = db.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
// 파일명 → { id, kind }. 'chiikawa.png' → 본체, 'chiikawa_wave.png' → 흔들기. 대소문자·확장자 무시
function parseSkinFilename(name) {
  const m = name.toLowerCase().match(/^([a-z_]+?)(_wave)?\.(png|webp|jpg|jpeg|gif)$/);
  if (!m || !speciesById(m[1])) return null;
  return { id: m[1], kind: m[2] ? 'wave' : 'img' };
}
function blobToImage(blob) { return new Promise((res) => { const url = URL.createObjectURL(blob); const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = url; }); }
// IndexedDB의 그림을 skinImages에 얹는다(manifest보다 우선). key = '<id>' | '<id>_wave'
async function loadLocalSkins() {
  try {
    const all = await dbAll();
    for (const [key, blob] of Object.entries(all)) {
      const m = key.match(/^([a-z_]+?)(_wave)?$/); if (!m) continue;
      const img = await blobToImage(blob); if (!img) continue;
      const cur = skinImages[m[1]] ?? { img: null, wave: null, scale: 1.1, dy: 0 };
      if (m[2]) cur.wave = img; else cur.img = img;
      skinImages[m[1]] = cur;
    }
    for (const k of Object.keys(skinImages)) if (skinImages[k] && !skinImages[k].img) skinImages[k] = null; // wave만 있으면 무효
    state.skins = Object.keys(skinImages).filter((k) => skinImages[k]);
    state.localSkins = Object.keys(all).length;
  } catch (e) { console.warn('local skins', e); }
}
async function importSkinFiles(files) {
  const entries = [], skipped = [];
  for (const f of files) {
    const p = parseSkinFilename(f.name);
    if (!p) { skipped.push(f.name); continue; }
    entries.push([p.kind === 'wave' ? `${p.id}_wave` : p.id, f]);
  }
  if (entries.length) await dbPut(entries);
  await loadLocalSkins();
  return { added: entries.map((e) => e[0]), skipped };
}
state.importSkinFiles = importSkinFiles; // 디버그용

// 상태 전이. progress 0=숨김(bbox.y+0.6h), 1=완전 등장(bbox.y+0.15h)
function updateCharacter(now) {
  const c = state.char;
  if (state.mode === 'hide') { c.state = 'hidden'; c.progress = 0; return; } // S21: 숨기기 모드에선 캐릭터가 나오지 않는다
  const locked = !!state.lock;
  if (!locked && c.state !== 'hidden' && c.state !== 'hide') {
    if (c.state === 'charging') { c.state = 'hidden'; c.progress = 0; } // 아직 안 나왔으면 바로 숨김
    else { c.state = 'hide'; c.since = now; }
  }
  if (confirmed() && (c.state === 'hidden' || c.state === 'hide')) { // S7: 확정되면 충전 시작
    c.sprite = pickSprite(); c.since = now; c.progress = 0; c.seed = Math.floor(Math.random() * 4); // S17: 파자마 멤버 색
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
  if (sp && skinImages[sp.id]) return drawSkin(ctx, skinImages[sp.id], cx, cy, size, t, opts); // S18: 원본 에셋 우선
  if (sp) { // S20: 기본은 픽셀. ?skin=drawn → S17 드로잉, ?skin=silhouette → 실루엣
    const style = params.get('skin');
    if (style === 'silhouette') return drawPlaceholder(ctx, sp, cx, cy, size, t, opts);
    if (style === 'drawn') return drawSpecies(ctx, sp, cx, cy, size, t, opts);
    return drawPixelChar(ctx, sp, cx, cy, size, t, opts);
  }
  return drawSoot(ctx, cx, cy, size, t, opts);
}

// S20: 픽셀 스프라이트 + 공통 배지(미수집 "!", 수집 반짝이)
function drawPixelChar(ctx, sp, cx, cy, size, t, opts) {
  const r = size / 2, bodyCy = cy - r;
  ctx.save();
  drawPixel(ctx, sp, cx, cy, size, t, { waving: opts.waving, tilt: opts.tilt });
  drawBadges(ctx, cx, bodyCy, r, size, t, opts);
  ctx.restore();
}

// ---- S17: 종별 캔버스 드로잉 ----
// 공통 기하: (cx, cy)=하단 중심, size=폭. 머리(몸통 겸) 원의 중심 = (cx, cy - r), r = size/2. 발은 바닥에.
const INK = '#3B322C';
function drawSpecies(ctx, sp, cx, cy, size, t, opts) {
  const r = size / 2, hy = cy - r;
  const blink = (t % 3400) < 110;
  const wobble = (opts.waving ? Math.sin(t / 60) * 0.08 : 0) + (opts.tilt ?? 0);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.translate(cx, hy); ctx.rotate(wobble); ctx.translate(-cx, -hy);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const lw = Math.max(2.5, size * 0.04);
  const g = { ctx, cx, cy, hy, r, size, t, blink, lw, sp, opts };
  const fn = SPECIES_DRAW[sp.id] ?? drawGenericChii;
  fn(g);
  drawBadges(ctx, cx, hy, r, size, t, opts);
  ctx.restore();
}
// --- 부품 ---
function body(g, color, rx = 1, ry = 0.98, dy = 0) { // 둥근 머리+몸통
  const { ctx, cx, hy, r, lw } = g;
  ctx.fillStyle = color; ctx.strokeStyle = INK; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.ellipse(cx, hy + r * dy, r * rx, r * ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}
function feet(g, color) { // 바닥에 닿는 작은 발 2개
  const { ctx, cx, cy, r, lw } = g;
  ctx.fillStyle = color; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.8;
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * r * 0.42, cy - r * 0.08, r * 0.2, r * 0.12, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
}
function arms(g, color, raise = 0) { // 짧은 팔. raise>0 이면 오른팔을 올림
  const { ctx, cx, hy, r, lw } = g;
  ctx.fillStyle = color; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.8;
  ctx.beginPath(); ctx.ellipse(cx - r * 0.95, hy + r * 0.35, r * 0.2, r * 0.12, -0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(cx + r * 0.95, hy + r * 0.35 - raise * r * 0.9, r * 0.2, r * 0.12, 0.5 - raise * 1.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}
function roundEars(g, color, inner) { // 치이카와: 작고 둥근 귀
  const { ctx, cx, hy, r, lw } = g;
  ctx.fillStyle = color; ctx.strokeStyle = INK; ctx.lineWidth = lw;
  for (const sx of [-1, 1]) {
    ctx.beginPath(); ctx.arc(cx + sx * r * 0.62, hy - r * 0.78, r * 0.26, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (inner) { ctx.fillStyle = inner; ctx.beginPath(); ctx.arc(cx + sx * r * 0.62, hy - r * 0.78, r * 0.13, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = color; }
  }
}
function catEars(g, color) { // 하치와레: 세모 귀
  const { ctx, cx, hy, r, lw } = g;
  ctx.fillStyle = color; ctx.strokeStyle = INK; ctx.lineWidth = lw;
  for (const sx of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(cx + sx * r * 0.35, hy - r * 0.85); ctx.lineTo(cx + sx * r * 0.78, hy - r * 1.25); ctx.lineTo(cx + sx * r * 0.9, hy - r * 0.55); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}
function longEars(g, color, inner) { // 우사기: 길게 선 귀
  const { ctx, cx, hy, r, lw } = g;
  ctx.fillStyle = color; ctx.strokeStyle = INK; ctx.lineWidth = lw;
  for (const sx of [-1, 1]) {
    ctx.beginPath(); ctx.ellipse(cx + sx * r * 0.45, hy - r * 1.35, r * 0.2, r * 0.62, sx * 0.12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = inner; ctx.beginPath(); ctx.ellipse(cx + sx * r * 0.45, hy - r * 1.3, r * 0.09, r * 0.42, sx * 0.12, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = color;
  }
}
function dotEyes(g, dx = 0.3, dy = -0.05, s = 0.07) {
  const { ctx, cx, hy, r, blink } = g; ctx.fillStyle = INK;
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * r * dx, hy + r * dy, r * s, blink ? r * 0.012 : r * s, 0, 0, Math.PI * 2); ctx.fill(); }
}
function bigEyes(g, lashes) { // 모몽가·세이렌: 큰 눈 + 하이라이트
  const { ctx, cx, hy, r, blink, lw } = g;
  for (const sx of [-1, 1]) {
    const ex = cx + sx * r * 0.32, ey = hy - r * 0.05;
    ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(ex, ey, r * 0.17, blink ? r * 0.015 : r * 0.22, 0, 0, Math.PI * 2); ctx.fill();
    if (!blink) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex - r * 0.05, ey - r * 0.08, r * 0.06, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(ex + r * 0.05, ey + r * 0.06, r * 0.03, 0, Math.PI * 2); ctx.fill(); }
    if (lashes) { ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.6; for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + sx * (0.25 + i * 0.35); ctx.beginPath(); ctx.moveTo(ex + Math.cos(a) * r * 0.18, ey + Math.sin(a) * r * 0.23); ctx.lineTo(ex + Math.cos(a) * r * 0.27, ey + Math.sin(a) * r * 0.33); ctx.stroke(); } }
  }
}
function sleepyEyes(g) { // 쿠리만쥬·랏코: 반쯤 감은 눈
  const { ctx, cx, hy, r, lw } = g; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.9;
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + sx * r * 0.2, hy - r * 0.02); ctx.lineTo(cx + sx * r * 0.42, hy - r * 0.02); ctx.stroke(); }
}
function narrowEyes(g) { // 시사: 가는 눈
  const { ctx, cx, hy, r, lw } = g; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.9;
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + sx * r * 0.32, hy - r * 0.02, r * 0.11, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
}
function omegaMouth(g, dy = 0.22) { // ω 입
  const { ctx, cx, hy, r, lw } = g; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.6;
  ctx.beginPath(); ctx.arc(cx - r * 0.07, hy + r * dy, r * 0.07, 0, Math.PI); ctx.arc(cx + r * 0.07, hy + r * dy, r * 0.07, 0, Math.PI); ctx.stroke();
}
function openMouth(g, w = 0.28, h = 0.2, dy = 0.28, tooth = false) { // 활짝 벌린 입
  const { ctx, cx, hy, r, lw } = g;
  ctx.fillStyle = '#C9424B'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.7;
  ctx.beginPath(); ctx.ellipse(cx, hy + r * dy, r * w, r * h, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#F08A9B'; ctx.beginPath(); ctx.ellipse(cx, hy + r * (dy + h * 0.45), r * w * 0.6, r * h * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  if (tooth) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.rect(cx - r * 0.05, hy + r * (dy - h * 0.95), r * 0.1, r * 0.1); ctx.fill(); }
}
function smileMouth(g) { // 하치와레: 활짝 웃는 입(위로 벌어진 반원 + 이빨)
  const { ctx, cx, hy, r, lw } = g;
  ctx.fillStyle = '#C9424B'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.7;
  ctx.beginPath(); ctx.arc(cx, hy + r * 0.2, r * 0.26, 0, Math.PI); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.rect(cx - r * 0.2, hy + r * 0.2, r * 0.4, r * 0.06); ctx.fill();
}
function cheeks(g, color, dy = 0.14) {
  const { ctx, cx, hy, r } = g; ctx.fillStyle = color;
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * r * 0.56, hy + r * dy, r * 0.15, r * 0.1, 0, 0, Math.PI * 2); ctx.fill(); }
}
function armorFace(g) { // 鎧さん 공통: 선글라스 같은 검은 눈 + 잇몸 드러난 입
  const { ctx, cx, hy, r, lw } = g;
  ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(cx - r * 0.62, hy - r * 0.22, r * 1.24, r * 0.3, r * 0.08); ctx.fill();
  ctx.fillStyle = '#E88A97'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.7;
  ctx.beginPath(); ctx.roundRect(cx - r * 0.45, hy + r * 0.22, r * 0.9, r * 0.36, r * 0.1); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.rect(cx - r * 0.4 + i * r * 0.16, hy + r * 0.25, r * 0.14, r * 0.14); ctx.fill(); }
  ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.5;
  for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(cx - r * 0.4 + i * r * 0.16, hy + r * 0.25); ctx.lineTo(cx - r * 0.4 + i * r * 0.16, hy + r * 0.39); ctx.stroke(); }
}
function armorBody(g, color, dark) { // 鎧さん: 투구(둥근 머리) + 판금 라인
  const { ctx, cx, hy, r, lw } = g;
  body(g, color, 1, 1.02);
  ctx.strokeStyle = dark; ctx.lineWidth = lw * 0.7;
  ctx.beginPath(); ctx.moveTo(cx - r * 0.95, hy - r * 0.32); ctx.quadraticCurveTo(cx, hy - r * 0.55, cx + r * 0.95, hy - r * 0.32); ctx.stroke(); // 투구 챙
  ctx.beginPath(); ctx.moveTo(cx - r * 0.98, hy + r * 0.62); ctx.quadraticCurveTo(cx, hy + r * 0.85, cx + r * 0.98, hy + r * 0.62); ctx.stroke(); // 턱받이
  ctx.beginPath(); ctx.moveTo(cx, hy - r); ctx.lineTo(cx, hy - r * 0.5); ctx.stroke(); // 투구 능선
}
function tag(g, text) { // 이름표(선택)
  const { ctx, cx, cy, r } = g;
  ctx.font = `bold ${Math.max(10, r * 0.24)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width + r * 0.4, th = r * 0.34, ty = cy + th * 0.7;
  ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.beginPath(); ctx.roundRect(cx - tw / 2, ty - th / 2, tw, th, th / 2); ctx.fill();
  ctx.fillStyle = INK; ctx.fillText(text, cx, ty + 1);
}
function drawGenericChii(g) { body(g, '#fff'); feet(g, '#fff'); dotEyes(g); omegaMouth(g); }

const SPECIES_DRAW = {
  // 치이카와: 흰 몸, 작고 둥근 귀, 점 눈, ω 입, 분홍 볼
  chiikawa(g) {
    roundEars(g, '#fff'); body(g, '#fff'); feet(g, '#fff'); arms(g, '#fff', g.opts.waving ? 1 : 0);
    cheeks(g, '#F7B6C2'); dotEyes(g); omegaMouth(g);
  },
  // 하치와레: 흰 몸에 머리 윗부분이 파란 하치와레 무늬(이마에서 두 갈래로 갈라짐), 세모 귀, 활짝 웃는 입
  hachiware(g) {
    const { ctx, cx, hy, r } = g;
    catEars(g, '#fff'); body(g, '#fff'); feet(g, '#fff'); arms(g, '#fff', g.opts.waving ? 1 : 0);
    ctx.save(); ctx.beginPath(); ctx.ellipse(cx, hy, r, r * 0.98, 0, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#7FB3E6';
    ctx.beginPath(); ctx.moveTo(cx - r * 1.1, hy - r * 1.1); ctx.lineTo(cx + r * 1.1, hy - r * 1.1);
    ctx.lineTo(cx + r * 1.1, hy - r * 0.42); ctx.lineTo(cx + r * 0.42, hy - r * 0.42); ctx.lineTo(cx, hy - r * 0.05); // 이마의 흰 쐐기
    ctx.lineTo(cx - r * 0.42, hy - r * 0.42); ctx.lineTo(cx - r * 1.1, hy - r * 0.42); ctx.closePath(); ctx.fill();
    ctx.restore();
    // 귀 안쪽도 파랗게
    ctx.fillStyle = '#7FB3E6';
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + sx * r * 0.42, hy - r * 0.88); ctx.lineTo(cx + sx * r * 0.76, hy - r * 1.18); ctx.lineTo(cx + sx * r * 0.85, hy - r * 0.62); ctx.closePath(); ctx.fill(); }
    cheeks(g, '#F7B6C2', 0.12); dotEyes(g, 0.3, -0.08); smileMouth(g);
  },
  // 우사기: 노란 몸, 길게 선 귀, 아주 작은 눈, 활짝 벌린 입("ウラ!")
  usagi(g) {
    longEars(g, '#FFF2A8', '#F9C5CC'); body(g, '#FFF2A8'); feet(g, '#FFF2A8'); arms(g, '#FFF2A8', 1);
    dotEyes(g, 0.3, -0.12, 0.05); openMouth(g, 0.22, 0.2, 0.22);
  },
  // 모몽가: 흰 복슬 몸, 분홍빛 비막(양옆 날개), 큰 반짝 눈 + 속눈썹, 크고 복슬한 꼬리
  momonga(g) {
    const { ctx, cx, hy, r, lw } = g;
    ctx.fillStyle = '#EED6E0'; ctx.strokeStyle = INK; ctx.lineWidth = lw; // 꼬리
    ctx.beginPath(); ctx.ellipse(cx + r * 0.95, hy + r * 0.55, r * 0.55, r * 0.32, -0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#F4B8D0'; // 비막
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + sx * r * 0.6, hy - r * 0.2); ctx.quadraticCurveTo(cx + sx * r * 1.35, hy + r * 0.1, cx + sx * r * 0.9, hy + r * 0.8); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    roundEars(g, '#fff', '#F4B8D0'); body(g, '#fff'); feet(g, '#fff');
    cheeks(g, '#F7B6C2'); bigEyes(g, true); omegaMouth(g, 0.26);
  },
  // 쿠리만쥬: 연노랑 몸에 머리 위 둥근 갈색 무늬(밤만쥬), 반쯤 감은 무표정 눈, 술캔
  kurimanju(g) {
    const { ctx, cx, hy, r, lw } = g;
    body(g, '#F6E7B8', 1, 0.95);
    ctx.save(); ctx.beginPath(); ctx.ellipse(cx, hy, r, r * 0.95, 0, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#8E5A2B'; ctx.beginPath(); ctx.ellipse(cx, hy - r * 0.62, r * 0.72, r * 0.42, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    feet(g, '#F6E7B8'); arms(g, '#F6E7B8', 0);
    sleepyEyes(g); ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.6; ctx.beginPath(); ctx.moveTo(cx - r * 0.1, hy + r * 0.25); ctx.lineTo(cx + r * 0.1, hy + r * 0.25); ctx.stroke(); // 一 입
    ctx.fillStyle = '#F2C94C'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.6; // 캔
    ctx.beginPath(); ctx.roundRect(cx + r * 0.75, hy + r * 0.12, r * 0.28, r * 0.42, r * 0.05); ctx.fill(); ctx.stroke();
  },
  // 시사: 금빛 몸, 주황 갈기와 눈썹, 가는 눈, 입가의 작은 송곳니
  shisa(g) {
    const { ctx, cx, hy, r, lw } = g;
    ctx.fillStyle = '#E8742C'; ctx.strokeStyle = INK; ctx.lineWidth = lw; // 갈기
    for (let i = 0; i < 9; i++) { const a = Math.PI + (i / 8) * Math.PI; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r * 0.95, hy + Math.sin(a) * r * 0.95, r * 0.27, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    body(g, '#F3C24B'); feet(g, '#F3C24B'); arms(g, '#F3C24B', g.opts.waving ? 1 : 0);
    ctx.strokeStyle = '#E8742C'; ctx.lineWidth = lw * 1.1; // 눈썹
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + sx * r * 0.18, hy - r * 0.32); ctx.lineTo(cx + sx * r * 0.48, hy - r * 0.26); ctx.stroke(); }
    narrowEyes(g); omegaMouth(g, 0.24);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.5; // 송곳니
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + sx * r * 0.16, hy + r * 0.26); ctx.lineTo(cx + sx * r * 0.2, hy + r * 0.4); ctx.lineTo(cx + sx * r * 0.26, hy + r * 0.26); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  },
  // 랏코: 갈색 몸에 밝은 얼굴, 작은 둥근 귀, 반쯤 감은 냉정한 눈, 등에 검
  rakko(g) {
    const { ctx, cx, hy, r, lw } = g;
    ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.9; ctx.fillStyle = '#C9CDD6'; // 검(등 뒤)
    ctx.beginPath(); ctx.moveTo(cx + r * 0.55, hy + r * 0.9); ctx.lineTo(cx + r * 1.25, hy - r * 0.9); ctx.lineTo(cx + r * 1.35, hy - r * 0.8); ctx.lineTo(cx + r * 0.7, hy + r * 0.95); ctx.closePath(); ctx.fill(); ctx.stroke();
    roundEars(g, '#8B6A4E'); body(g, '#8B6A4E'); feet(g, '#8B6A4E'); arms(g, '#8B6A4E', 0);
    ctx.fillStyle = '#E9D9C3'; ctx.beginPath(); ctx.ellipse(cx, hy + r * 0.05, r * 0.72, r * 0.6, 0, 0, Math.PI * 2); ctx.fill(); // 밝은 얼굴
    sleepyEyes(g); ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(cx, hy + r * 0.2, r * 0.07, r * 0.05, 0, 0, Math.PI * 2); ctx.fill(); // 코
    ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.5; ctx.beginPath(); ctx.moveTo(cx - r * 0.12, hy + r * 0.34); ctx.lineTo(cx + r * 0.12, hy + r * 0.34); ctx.stroke();
  },
  // 헌책방(카니짱): 분홍 게 모양 — 옆으로 넓은 몸, 눈자루 위의 눈, 집게, 안경 대신 책
  furuhonya(g) {
    const { ctx, cx, hy, r, lw } = g;
    ctx.fillStyle = '#F6B7C6'; ctx.strokeStyle = INK; ctx.lineWidth = lw;
    for (const sx of [-1, 1]) { // 집게
      ctx.beginPath(); ctx.ellipse(cx + sx * r * 1.05, hy + r * 0.05, r * 0.3, r * 0.22, sx * 0.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + sx * r * 1.05, hy - r * 0.05); ctx.lineTo(cx + sx * r * 1.3, hy - r * 0.3); ctx.stroke();
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(cx + sx * r * (0.75 + i * 0.12), hy + r * 0.25); ctx.lineTo(cx + sx * r * (0.85 + i * 0.12), hy + r * 0.6); ctx.stroke(); } // 다리
    }
    body(g, '#F6B7C6', 1.05, 0.8, 0.1);
    for (const sx of [-1, 1]) { // 눈자루
      ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.8; ctx.beginPath(); ctx.moveTo(cx + sx * r * 0.3, hy - r * 0.6); ctx.lineTo(cx + sx * r * 0.32, hy - r * 1.0); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx + sx * r * 0.32, hy - r * 1.05, r * 0.14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(cx + sx * r * 0.32, hy - r * 1.05, r * 0.06, 0, Math.PI * 2); ctx.fill();
    }
    omegaMouth(g, 0.18);
    ctx.fillStyle = '#E9D9C3'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.6; // 책
    ctx.beginPath(); ctx.roundRect(cx - r * 0.3, hy + r * 0.32, r * 0.6, r * 0.42, r * 0.04); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, hy + r * 0.32); ctx.lineTo(cx, hy + r * 0.74); ctx.stroke();
  },
  // 데카츠요: 치이카와족의 크고 강한 개체 — 흰 몸, 각진 눈, 이 드러낸 씩 웃음, 굵은 팔
  dekatsuyo(g) {
    const { ctx, cx, hy, r, lw } = g;
    roundEars(g, '#fff'); body(g, '#fff', 1.05, 1.0); feet(g, '#fff');
    ctx.fillStyle = '#fff'; ctx.strokeStyle = INK; ctx.lineWidth = lw;
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * r * 1.0, hy + r * 0.35, r * 0.3, r * 0.2, sx * 0.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.9; // 각진 눈
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + sx * r * 0.14, hy - r * 0.05); ctx.lineTo(cx + sx * r * 0.42, hy - r * 0.2); ctx.stroke(); ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(cx + sx * r * 0.3, hy - r * 0.02, r * 0.06, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#fff'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.7; // 씩 웃는 입
    ctx.beginPath(); ctx.moveTo(cx - r * 0.3, hy + r * 0.2); ctx.quadraticCurveTo(cx, hy + r * 0.5, cx + r * 0.3, hy + r * 0.2); ctx.closePath(); ctx.fill(); ctx.stroke();
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(cx - r * 0.3 + i * r * 0.15, hy + r * 0.2); ctx.lineTo(cx - r * 0.3 + i * r * 0.15, hy + r * 0.33); ctx.stroke(); }
  },
  // 파자마 파티즈: 파자마(줄무늬)와 나이트캡을 쓴 작은 치이카와족. 멤버 색은 등장마다 보라·분홍·초록·흰
  pajama(g) {
    const { ctx, cx, hy, r, lw, t } = g;
    const cols = ['#A9A0D6', '#F4A6C0', '#8FD0A0', '#F3EFE4'];
    const col = cols[Math.floor((g.opts.seed ?? 0) % 4)];
    body(g, '#fff'); feet(g, '#fff'); arms(g, '#fff', g.opts.waving ? 1 : 0);
    ctx.save(); ctx.beginPath(); ctx.ellipse(cx, hy, r, r * 0.98, 0, 0, Math.PI * 2); ctx.clip(); // 파자마(아래 절반)
    ctx.fillStyle = col; ctx.fillRect(cx - r, hy + r * 0.35, r * 2, r);
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = lw * 0.6;
    for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(cx + i * r * 0.28, hy + r * 0.35); ctx.lineTo(cx + i * r * 0.28, hy + r * 1.1); ctx.stroke(); }
    ctx.restore();
    ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.7; ctx.beginPath(); ctx.moveTo(cx - r, hy + r * 0.35); ctx.lineTo(cx + r, hy + r * 0.35); ctx.stroke();
    ctx.fillStyle = col; ctx.strokeStyle = INK; ctx.lineWidth = lw; // 나이트캡
    ctx.beginPath(); ctx.moveTo(cx - r * 0.75, hy - r * 0.62); ctx.quadraticCurveTo(cx, hy - r * 1.35, cx + r * 0.55, hy - r * 0.85); ctx.quadraticCurveTo(cx + r * 1.0, hy - r * 1.1, cx + r * 1.05, hy - r * 0.65); ctx.quadraticCurveTo(cx + r * 0.2, hy - r * 0.75, cx - r * 0.75, hy - r * 0.62); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx + r * 1.05, hy - r * 0.62, r * 0.14, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); // 방울
    cheeks(g, '#F7B6C2'); dotEyes(g); omegaMouth(g);
  },
  // 세이렌: 상반신은 고양이 같은 얼굴(곤란한 눈썹·큰 눈·고양이 입), 하반신은 물고기 꼬리
  seiren(g) {
    const { ctx, cx, hy, cy, r, lw } = g;
    ctx.fillStyle = '#5FB3C4'; ctx.strokeStyle = INK; ctx.lineWidth = lw; // 꼬리
    ctx.beginPath(); ctx.moveTo(cx - r * 0.6, hy + r * 0.6); ctx.quadraticCurveTo(cx - r * 0.2, cy + r * 0.1, cx - r * 0.9, cy + r * 0.05);
    ctx.lineTo(cx - r * 0.55, cy - r * 0.15); ctx.lineTo(cx - r * 0.95, cy - r * 0.4); ctx.quadraticCurveTo(cx, cy - r * 0.25, cx + r * 0.6, hy + r * 0.6); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = lw * 0.5;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(cx - r * 0.1 - i * r * 0.2, hy + r * 0.85 + i * r * 0.05, r * 0.12, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); } // 비늘
    catEars(g, '#F3EFE4'); body(g, '#F3EFE4', 0.95, 0.9);
    ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.8; // 곤란한 눈썹
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + sx * r * 0.18, hy - r * 0.4); ctx.lineTo(cx + sx * r * 0.45, hy - r * 0.3); ctx.stroke(); }
    bigEyes(g, false); omegaMouth(g, 0.24);
  },
  // 鎧さん(라면): 노란 갑옷, 머리에 흰 수건, 선글라스 눈 + 잇몸 입
  yoroi_ramen(g) {
    const { ctx, cx, hy, r, lw } = g;
    armorBody(g, '#F2C94C', '#B48A1E'); feet(g, '#F2C94C'); arms(g, '#F2C94C', 0);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.8; // 수건
    ctx.beginPath(); ctx.moveTo(cx - r * 0.98, hy - r * 0.35); ctx.quadraticCurveTo(cx, hy - r * 0.62, cx + r * 0.98, hy - r * 0.35);
    ctx.lineTo(cx + r * 0.95, hy - r * 0.55); ctx.quadraticCurveTo(cx, hy - r * 1.2, cx - r * 0.95, hy - r * 0.55); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + r * 0.9, hy - r * 0.5); ctx.lineTo(cx + r * 1.25, hy - r * 0.2); ctx.lineTo(cx + r * 1.0, hy - r * 0.3); ctx.closePath(); ctx.fill(); ctx.stroke(); // 매듭
    armorFace(g);
  },
  // 鎧さん(안내소): 은색 갑옷, 가슴에 'i' 표식
  yoroi_info(g) {
    const { ctx, cx, hy, r } = g;
    armorBody(g, '#C9CDD6', '#8A9099'); feet(g, '#C9CDD6'); arms(g, '#C9CDD6', 0);
    armorFace(g);
    ctx.fillStyle = '#2F6FE4'; ctx.beginPath(); ctx.arc(cx, hy + r * 0.78, r * 0.13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${r * 0.2}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('i', cx, hy + r * 0.79);
  },
  // 鎧さん(포셰트): 파란 갑옷, 곰 포셰트, 등에 검
  yoroi_pochette(g) {
    const { ctx, cx, hy, r, lw } = g;
    ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.9; ctx.fillStyle = '#C9CDD6'; // 검
    ctx.beginPath(); ctx.moveTo(cx - r * 0.6, hy + r * 0.9); ctx.lineTo(cx - r * 1.25, hy - r * 0.9); ctx.lineTo(cx - r * 1.35, hy - r * 0.8); ctx.lineTo(cx - r * 0.75, hy + r * 0.95); ctx.closePath(); ctx.fill(); ctx.stroke();
    armorBody(g, '#5B8DD9', '#2F5AA8'); feet(g, '#5B8DD9'); arms(g, '#5B8DD9', 0);
    armorFace(g);
    ctx.strokeStyle = '#8B5E3C'; ctx.lineWidth = lw * 0.6; ctx.beginPath(); ctx.moveTo(cx - r * 0.7, hy - r * 0.1); ctx.lineTo(cx + r * 0.55, hy + r * 0.85); ctx.stroke(); // 끈
    ctx.fillStyle = '#8B5E3C'; ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.6; // 곰 포셰트
    ctx.beginPath(); ctx.arc(cx + r * 0.6, hy + r * 0.85, r * 0.22, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + r * 0.6 + sx * r * 0.16, hy + r * 0.68, r * 0.08, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = INK; for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + r * 0.6 + sx * r * 0.07, hy + r * 0.82, r * 0.025, 0, Math.PI * 2); ctx.fill(); }
  },
};
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
function drawSkin(ctx, skin, cx, cy, size, t, opts) {
  const r = size / 2, bodyCy = cy - r;
  const img = (opts.waving && skin.wave) || skin.img; // S18: wave 전용 그림이 있으면 흔들 때 교체
  const w = size * skin.scale, h = w * (img.naturalHeight / img.naturalWidth);
  const wobble = ((opts.waving && !skin.wave) ? Math.sin(t / 60) * 0.08 : 0) + (opts.tilt ?? 0);
  ctx.save();
  ctx.globalAlpha = 1; // S16: 미수집도 불투명(구분은 '!' 말풍선)
  ctx.translate(cx, cy); ctx.rotate(wobble); ctx.translate(-cx, -cy);
  ctx.drawImage(img, cx - w / 2, cy - h + size * skin.dy, w, h);
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
      seed: c.seed ?? 0, // S17
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
  renderSeekbar(); // S21
  hud.textContent =
    `det ${hz(state.detTimes, t)} Hz | seg ${hz(state.segTimes, t)} Hz | fps ${hz(state.frameTimes, t)} | ${state.delegate}\n` +
    `video ${video.videoWidth}x${video.videoHeight}\n` +
    `lock ${state.lock ? state.lock.label : '-'} | miss ${(state.missMs / 1000).toFixed(1)}s | char ${state.char.state}\n` +
    `mask ${USE_MASK ? (state.mask ? 'on' : 'none') : 'off'} | rej ${state.maskRejects}\n` +
    `phase ${state.phase} | home ${state.home?.label ?? '-'}${state.home?.solved ? '✓' : ''} | near ${state.near.toFixed(2)} | hits ${state.hits}\n` +
    `sprite ${state.char.sprite?.id ?? '-'}${isNight() ? ' night' : ''} | col ${state.collection.length}/${SPECIES.length} | px ${state.parallax.x.toFixed(2)} py ${state.parallax.y.toFixed(2)}\n` +
    `mode ${state.mode}${state.cache ? ' #' + state.cache.id : ''} | dist ${state.dist == null ? '-' : Math.round(state.dist) + 'm'} | acc ${state.geo ? Math.round(state.geo.acc) + 'm' : '-'} | far ${seekFar() ? 'y' : 'n'}\n` +
    `skin ${state.skins ? state.skins.length + '/' + SPECIES.length : '-'} | ` +
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
    state.collection.push({ id: c.sprite.id, label: state.lock?.label ?? '?', at: Date.now(), night: isNight(), cache: state.cache?.id });
    store.set('collection', state.collection);
    if (state.cache && !state.finds.includes(state.cache.id)) { state.finds.push(state.cache.id); store.set('finds', state.finds); } // S21
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
  if (state.mode === 'hide') { // S21
    text = !state.lock ? '숨길 물건을 비춰보세요' : !confirmed() ? '잠깐 가만히…' : `${state.lock.label} 뒤에 숨길 수 있어요 → 아래 버튼`;
    if (msg.textContent !== text) msg.textContent = text;
    hideBtn.hidden = !(state.lock && confirmed()) || !hidecard.hidden;
    return;
  }
  if (state.mode === 'seek' && seekFar()) { // S21
    text = state.dist == null ? '숨긴 곳의 위치를 확인하는 중…' : '화살표 방향으로 이동하세요. 가까워지면 물건이 빛나요';
    if (msg.textContent !== text) msg.textContent = text;
    return;
  }
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
        drawPixel(g, sp, 48, 90, 66, 1000, { silhouette: true }); // S20: 픽셀 실루엣
        g.fillStyle = '#fff'; g.font = 'bold 18px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 48, 56);
      }
      el.appendChild(cv);
      const cap = document.createElement('div');
      cap.textContent = got ? `${sp.name} · ${got.label}${got.night ? ' · 심야' : ''}` : (sp.night ? `??? · 심야에만` : `??? · ${RARITY[sp.rarity].name}`);
      el.appendChild(cap); grid.appendChild(el);
    }
    group.appendChild(grid); slots.appendChild(group);
  }
  panel.querySelector('#skinstat').textContent = `원본 그림 ${state.skins?.length ?? 0}/${SPECIES.length}` + (state.localSkins ? ` (기기 저장 ${state.localSkins}파일)` : ''); // S19
  panel.querySelector('#home').textContent = state.home
    ? `숨은 곳: ${state.home.solved ? state.home.label + ' (맞춤!)' : '??? (빛나는 물건을 찾아보세요)'} · 스캔에서 본 물체: ${(state.home.seen ?? [state.home.label]).join(', ')}`
    : '스캔 중…';
}
badge.addEventListener('click', () => { renderPanel(); panel.hidden = !panel.hidden; });
panel.addEventListener('click', (e) => { if (e.target === panel) panel.hidden = true; });
// S19: 원본 그림 넣기 / 지우기
const skinInput = panel.querySelector('#skinfile');
panel.querySelector('#skinpick').addEventListener('click', () => skinInput.click());
skinInput.addEventListener('change', async () => {
  const r = await importSkinFiles([...skinInput.files]);
  skinInput.value = '';
  renderPanel();
  panel.querySelector('#skinmsg').textContent = `넣음 ${r.added.length}개` + (r.skipped.length ? ` · 무시 ${r.skipped.length}개 (파일명이 <id>.png 형식이 아님: ${r.skipped.slice(0, 3).join(', ')})` : '');
});
panel.querySelector('#skinclear').addEventListener('click', async () => {
  if (!confirm('기기에 넣은 원본 그림을 모두 지울까요?')) return;
  await dbClear(); for (const k of Object.keys(skinImages)) delete skinImages[k];
  await loadSkin(); await loadLocalSkins(); renderPanel();
  panel.querySelector('#skinmsg').textContent = '지웠음';
});
panel.querySelector('#reset').addEventListener('click', () => {
  if (!confirm('기억한 물체와 도감을 모두 지울까요?')) return;
  store.clear(); state.home = null; state.collection = [];
  startScan(performance.now()); // S8: 다시 스캔
  renderBadge(); renderPanel(); panel.hidden = true;
});

// ---- S21: 숨기기 UI ----
const hideBtn = document.getElementById('hidebtn');
const hidecard = document.getElementById('hidecard');
let pendingCache = null;
function showHideCard(c) {
  pendingCache = c;
  const sp = speciesById(c.sp);
  hidecard.querySelector('#hc-sp').textContent = `${sp.name} · ${c.label} 뒤`;
  hidecard.querySelector('#hc-geo').textContent = c.lat != null ? `위치 저장됨 (오차 ±${c.acc}m)${c.heading != null ? ' · 방향 저장됨' : ''}` : '위치 없음 (GPS 미허용) — 링크로만 찾을 수 있어요';
  hidecard.querySelector('#hc-url').value = cacheUrl(c);
  hidecard.hidden = false; hideBtn.hidden = true;
}
hideBtn.addEventListener('click', () => { const c = makeCache(); if (c) showHideCard(c); });
hidecard.querySelector('#hc-reroll').addEventListener('click', () => { if (!pendingCache) return; pendingCache.sp = pickSpriteForHide(pendingCache.label).id; showHideCard(pendingCache); });
hidecard.querySelector('#hc-share').addEventListener('click', async () => {
  const c = pendingCache; if (!c) return;
  const url = cacheUrl(c);
  if (!state.hides.some((h) => h.id === c.id)) { state.hides.push(c); store.set('hides', state.hides); }
  try {
    if (navigator.share) await navigator.share({ title: 'Peekaboo 숨바꼭질', text: `${speciesById(c.sp).name}를 숨겼어요. 찾아보세요!`, url });
    else { await navigator.clipboard.writeText(url); hidecard.querySelector('#hc-msg').textContent = '링크를 복사했어요'; }
  } catch (e) { if (e.name !== 'AbortError') { try { await navigator.clipboard.writeText(url); hidecard.querySelector('#hc-msg').textContent = '링크를 복사했어요'; } catch { hidecard.querySelector('#hc-msg').textContent = '아래 링크를 길게 눌러 복사하세요'; } } }
});
hidecard.querySelector('#hc-close').addEventListener('click', () => { hidecard.hidden = true; pendingCache = null; });
document.getElementById('bypass').addEventListener('click', () => { state.geoBypass = true; });

// ---- 시작 ----
async function main(mode = 'scan') {
  document.getElementById('menu').hidden = true;
  state.mode = mode;
  if (mode === 'seek' && !state.cache) { // 링크 붙여넣기
    const txt = prompt('숨긴 사람에게 받은 링크를 붙여넣으세요') ?? '';
    let c = null; try { c = decodeCache(new URL(txt.trim()).searchParams.get('c') ?? txt.trim()); } catch { c = decodeCache(txt.trim()); }
    if (!c) { alert('링크를 읽을 수 없어요'); document.getElementById('menu').hidden = false; return; }
    beginSeek(c);
  }
  if (mode === 'hide') { state.phase = 'play'; state.home = null; state.cache = null; }
  if (mode === 'scan') state.cache = null;
  await requestOrientation(); // S15
  if (mode !== 'scan') startGeo(); // S21
  resizeCanvas();
  try {
    await startCamera();
    msg.textContent = '모델 로딩 중…';
    await createDetector();
    await createSegmenter(); // S4
    msg.textContent = '';
    shutterBtn.hidden = false; // S5
    badge.hidden = false; renderBadge(); // S7
    if (state.mode === 'scan' && state.phase === 'scan') startScan(performance.now()); // S8
    else state.playStart = performance.now(); // S14
    video.requestVideoFrameCallback(onVideoFrame);
  } catch (e) {
    console.error(e);
    state.error = e.message || String(e);
    msg.textContent = `오류: ${state.error}\n(HTTPS·카메라 권한을 확인하세요)`;
  }
}

requestAnimationFrame(render);
// S21: 시작 메뉴. ?c=... 링크로 열면 바로 찾기 모드
const CACHE_FROM_URL = params.get('c') ? decodeCache(params.get('c')) : null;
if (CACHE_FROM_URL) { beginSeek(CACHE_FROM_URL); document.getElementById('menu-title').textContent = `${speciesById(CACHE_FROM_URL.sp)?.name ?? '먼작귀'}가 ${CACHE_FROM_URL.label} 뒤에 숨어 있어요`; }
document.getElementById('m-hide').addEventListener('click', () => main('hide'));
document.getElementById('m-seek').addEventListener('click', () => main('seek'));
document.getElementById('m-scan').addEventListener('click', () => main('scan'));
if (params.get('mode') === 'hide') main('hide');

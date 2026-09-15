// Peekaboo AR — 물체 뒤 캐릭터. 단계 번호(S1, S2, ...)는 각 코드가 추가된 단계다.
// S1: 카메라 + MediaPipe ObjectDetector 루프 + 디버그 오버레이

const VISION_VERSION = '0.10.35';
const VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const DETECTOR_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

const params = new URLSearchParams(location.search);
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
};
window.__peekaboo = state;

// ---- 유틸 ----
function hz(times, now) {
  while (times.length && now - times[0] > 1000) times.shift();
  return times.length;
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
}

// ---- 검출기 ----
let detector = null;
async function createDetector() {
  const { FilesetResolver, ObjectDetector } = await import(`${VISION_CDN}/vision_bundle.mjs`);
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
  return { ObjectDetector, fileset };
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
  }
  video.requestVideoFrameCallback(onVideoFrame);
}

// ---- 렌더 루프 (rAF) ----
function drawDetections(t) {
  const { s, ox, oy } = coverTransform();
  ctx.font = `${14 * (canvas.width / canvas.clientWidth)}px ui-monospace, monospace`;
  ctx.lineWidth = 2;
  for (const d of state.detections) {
    const x = ox + d.x * s, y = oy + d.y * s, w = d.w * s, h = d.h * s;
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.strokeRect(x, y, w, h);
    const label = `${d.label} ${d.score.toFixed(2)}`;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(x, y - 18, ctx.measureText(label).width + 8, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 4, y - 4);
  }
}

function render(t) {
  state.frameTimes.push(t);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (video.videoWidth) drawDetections(t);
  hud.textContent =
    `det ${hz(state.detTimes, t)} Hz | fps ${hz(state.frameTimes, t)} | ${state.delegate}\n` +
    `video ${video.videoWidth}x${video.videoHeight}` +
    (state.error ? `\nERR ${state.error}` : '');
  requestAnimationFrame(render);
}

// ---- 시작 ----
async function main() {
  startBtn.hidden = true;
  resizeCanvas();
  try {
    await startCamera();
    msg.textContent = '모델 로딩 중…';
    await createDetector();
    msg.textContent = '';
    video.requestVideoFrameCallback(onVideoFrame);
  } catch (e) {
    console.error(e);
    state.error = e.message || String(e);
    msg.textContent = `오류: ${state.error}\n(HTTPS·카메라 권한을 확인하세요)`;
  }
}

requestAnimationFrame(render);
startBtn.addEventListener('click', main, { once: true });

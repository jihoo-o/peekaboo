// Peekaboo — 픽셀 캐릭터 (S20). 다마고치 문법: 1px 검은 외곽선, 평면 2~3톤, 콩알 눈 + 흰 하이라이트, 뭉툭한 팔·발, 머리 위 액세서리.
// 14종 전부 부품 조합으로 코드에서 생성한다(그림 파일 없음). 특정 기존 캐릭터의 도트를 복제하지 않은 새 디자인이다.
// app.js와 docs/preview/pixel-sheet.html이 함께 쓴다(ADR-0025).

export const PW = 22, PH = 24; // 격자 크기. 바닥 = 마지막 두 줄(발)
const FIXED = { k: '#3B322C', w: '#FFFFFF', e: '#1F1B1A', m: '#D9534F', p: '#F5A3B0', g: '#B9BCC4', d: '#8A8F99', n: '#F6D96B', t: '#2E7D8C', c: '#5B8DD9', o: '#E8742C', r: '#8E5A2B', y: '#F2C94C' };

// ---- 격자 헬퍼 ----
function grid() { return Array.from({ length: PH }, () => Array(PW).fill(null)); }
const set = (g, x, y, c, p) => { if (x >= 0 && y >= 0 && x < PW && y < PH) g[y][x] = { c, p }; };
function ell(g, cx, cy, rx, ry, c, p) { for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) { const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry; if (dx * dx + dy * dy <= 1) set(g, x, y, c, p); } }
function rect(g, x, y, w, h, c, p) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(g, x + i, y + j, c, p); }
function tri(g, cx, baseY, halfW, height, c, p, up = true) { // 위로(up) 또는 아래로 뾰족한 삼각형
  for (let j = 0; j < height; j++) { const w = Math.max(0, Math.round(halfW * (1 - j / height))); const y = up ? baseY - j : baseY + j; for (let x = cx - w; x <= cx + w; x++) set(g, x, y, c, p); }
}
// 외곽선: 비어 있는 이웃이 있거나, 더 위에 얹힌 부품(p가 큼)과 맞닿은 픽셀을 검게. 1px 두께. 제자리에서 바꾼다(얼굴 클로저가 같은 격자를 쓴다).
function outline(g) {
  const marks = [];
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const v = g[y][x]; if (!v) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      const n = nx < 0 || ny < 0 || nx >= PW || ny >= PH ? null : g[ny][nx];
      if (!n || (n.p !== v.p && n.p > v.p)) { marks.push([x, y, v.p]); break; }
    }
  }
  for (const [x, y, p] of marks) g[y][x] = { c: 'k', p };
}
// ---- 얼굴 부품 (외곽선 뒤에 얹는다) ----
const F = {
  eye(g, x, y, blink, big = false) { // 콩알 눈 2×3 + 하이라이트. blink면 2×1 선
    if (blink) { set(g, x, y + 1, 'e', 9); set(g, x + 1, y + 1, 'e', 9); return; }
    rect(g, x, y, 2, 3, 'e', 9); set(g, x, y, 'w', 9); if (big) { rect(g, x - 1, y - 1, 3, 4, 'e', 9); set(g, x - 1, y - 1, 'w', 9); set(g, x + 1, y + 1, 'w', 9); }
  },
  omega(g, cx, y) { set(g, cx - 1, y, 'k', 9); set(g, cx + 1, y, 'k', 9); set(g, cx, y + 1, 'k', 9); set(g, cx - 2, y + 1, 'k', 9); set(g, cx + 2, y + 1, 'k', 9); }, // ω
  smile(g, cx, y) { set(g, cx - 1, y, 'k', 9); set(g, cx, y + 1, 'k', 9); set(g, cx + 1, y, 'k', 9); },
  grin(g, cx, y) { rect(g, cx - 2, y, 5, 1, 'k', 9); rect(g, cx - 1, y + 1, 3, 1, 'm', 9); set(g, cx - 2, y + 1, 'k', 9); set(g, cx + 2, y + 1, 'k', 9); rect(g, cx - 1, y + 2, 3, 1, 'k', 9); }, // 활짝
  open(g, cx, y) { rect(g, cx - 1, y, 3, 3, 'k', 9); set(g, cx, y + 1, 'm', 9); }, // 벌린 입
  flat(g, cx, y) { rect(g, cx - 1, y, 3, 1, 'k', 9); },
  gum(g, cx, y) { rect(g, cx - 3, y, 7, 1, 'k', 9); rect(g, cx - 2, y + 1, 5, 1, 'p', 9); for (let i = -2; i <= 2; i += 2) set(g, cx + i, y + 1, 'w', 9); rect(g, cx - 3, y + 1, 1, 1, 'k', 9); rect(g, cx + 3, y + 1, 1, 1, 'k', 9); rect(g, cx - 2, y + 2, 5, 1, 'k', 9); }, // 잇몸 드러난 입
  blush(g, x, y) { rect(g, x, y, 2, 1, 'p', 9); },
  brow(g, x, y, dir) { set(g, x, y, 'k', 9); set(g, x + 1, y + dir, 'k', 9); }, // dir: -1 안쪽 올라감(화남/의지), +1 내려감(곤란)
  fang(g, x, y) { set(g, x, y, 'w', 9); },
  band(g, cx, y) { rect(g, cx - 4, y, 9, 2, 'e', 9); set(g, cx - 3, y, 'w', 9); set(g, cx + 2, y, 'w', 9); }, // 갑옷 눈: 검은 띠 + 하이라이트
};
// ---- 몸 부품 ----
const B = {
  feet(g, cx, c) { rect(g, cx - 5, 21, 3, 2, c, 1); rect(g, cx + 2, 21, 3, 2, c, 1); },
  round(g, cx, c, r = 7.5) { ell(g, cx, 13, r, r, c, 2); },
  egg(g, cx, c) { ell(g, cx, 13.5, 6.5, 8, c, 2); ell(g, cx, 16, 7, 5.5, c, 2); },
  big(g, cx, c) { ell(g, cx, 12.5, 8.5, 8.5, c, 2); },
  arms(g, cx, c, up = false) { if (up) { rect(g, cx - 10, 9, 2, 3, c, 2); rect(g, cx + 8, 9, 2, 3, c, 2); } else { rect(g, cx - 9, 13, 2, 2, c, 2); rect(g, cx + 7, 13, 2, 2, c, 2); } },
  earsRound(g, cx, c) { ell(g, cx - 5, 6.5, 2, 2, c, 2); ell(g, cx + 5, 6.5, 2, 2, c, 2); },
  earsCat(g, cx, c) { tri(g, cx - 5, 7, 2, 4, c, 2); tri(g, cx + 5, 7, 2, 4, c, 2); },
  earsLong(g, cx, c, inner) { rect(g, cx - 5, 0, 3, 8, c, 2); rect(g, cx + 2, 0, 3, 8, c, 2); if (inner) { rect(g, cx - 4, 1, 1, 5, inner, 2); rect(g, cx + 3, 1, 1, 5, inner, 2); } },
  cap(g, cx, c) { ell(g, cx, 10, 8, 5.5, c, 3); rect(g, cx - 8, 9, 17, 1, c, 3); }, // 머리 윗부분 덮개(무늬)
  helmetBand(g, cx, c) { rect(g, cx - 7, 5, 15, 3, c, 3); }, // 수건·띠
  nightcap(g, cx, c) { tri(g, cx + 1, 6, 7, 7, c, 3); rect(g, cx - 7, 6, 15, 2, 'w', 4); ell(g, cx + 6, 1.5, 1.6, 1.6, 'w', 5); },
  mane(g, cx, c) { for (let a = 0; a < 16; a++) { const th = (a / 16) * Math.PI * 2; ell(g, cx + Math.cos(th) * 8.5, 13 + Math.sin(th) * 8.5, 2, 2, c, 0); } },
  tail(g, cx, c) { ell(g, cx + 9, 15, 4, 6, c, 0); },
  fin(g, cx, c) { rect(g, cx - 6, 17, 13, 5, c, 3); tri(g, cx - 7, 22, 2, 3, c, 3, false); tri(g, cx + 7, 22, 2, 3, c, 3, false); rect(g, cx - 3, 19, 7, 1, 'w', 4); },
  claws(g, cx, c) { rect(g, cx - 11, 11, 3, 4, c, 2); set(g, cx - 10, 12, null, 2); rect(g, cx + 8, 11, 3, 4, c, 2); set(g, cx + 9, 12, null, 2); },
  sword(g, cx) { rect(g, cx + 9, 6, 1, 8, 'g', 3); rect(g, cx + 8, 13, 3, 1, 'r', 3); },
  book(g, cx, c) { rect(g, cx - 3, 15, 7, 4, c, 3); rect(g, cx, 15, 1, 4, 'w', 4); },
  badge(g, cx, c) { rect(g, cx - 1, 4, 2, 1, c, 3); rect(g, cx - 1, 6, 2, 2, c, 3); },
  pochette(g, cx, c) { rect(g, cx + 5, 14, 4, 4, c, 3); rect(g, cx - 4, 8, 10, 1, c, 3); },
  patch(g, cx, c) { ell(g, cx, 7.5, 4.5, 2.5, c, 3); },
  facePatch(g, cx, c) { ell(g, cx, 13, 5, 4.5, c, 3); },
  stripes(g, cx, c) { for (let y = 16; y <= 20; y += 2) rect(g, cx - 7, y, 15, 1, c, 3); },
  sprout(g, cx, c) { rect(g, cx, 3, 1, 3, c, 3); ell(g, cx - 2, 3, 2, 1.2, c, 3); ell(g, cx + 2, 2.5, 2, 1.2, c, 3); },
};

// ---- 종별 조립. (sp.color = 'b', sp.tone = 'a') ----
const DEFS = {
  chiikawa(g, cx, k) { B.feet(g, cx, 'b'); B.round(g, cx, 'b'); B.arms(g, cx, 'b'); B.earsRound(g, cx, 'b'); return () => { F.eye(g, cx - 4, 11, k); F.eye(g, cx + 3, 11, k); F.omega(g, cx, 15); F.blush(g, cx - 7, 14); F.blush(g, cx + 6, 14); }; },
  hachiware(g, cx, k) { B.feet(g, cx, 'b'); B.round(g, cx, 'b'); B.arms(g, cx, 'b', true); B.earsCat(g, cx, 'a'); B.cap(g, cx, 'a'); rect(g, cx - 1, 6, 3, 5, 'b', 3); return () => { F.eye(g, cx - 4, 11, k); F.eye(g, cx + 3, 11, k); F.grin(g, cx, 15); F.blush(g, cx - 7, 14); F.blush(g, cx + 6, 14); }; },
  usagi(g, cx, k) { B.feet(g, cx, 'b'); B.egg(g, cx, 'b'); B.arms(g, cx, 'b', true); B.earsLong(g, cx, 'b', 'p'); return () => { F.eye(g, cx - 4, 11, k); F.eye(g, cx + 3, 11, k); F.open(g, cx, 15); }; },
  momonga(g, cx, k) { B.tail(g, cx, 'b'); B.feet(g, cx, 'b'); B.round(g, cx, 'b'); B.arms(g, cx, 'b'); B.earsRound(g, cx, 'b'); return () => { F.eye(g, cx - 4, 11, k, true); F.eye(g, cx + 3, 11, k, true); F.omega(g, cx, 15); F.blush(g, cx - 7, 14); F.blush(g, cx + 6, 14); }; },
  kurimanju(g, cx, k) { B.feet(g, cx, 'b'); B.egg(g, cx, 'b'); B.arms(g, cx, 'b'); B.patch(g, cx, 'a'); return () => { F.eye(g, cx - 4, 12, true); F.eye(g, cx + 3, 12, true); F.flat(g, cx, 16); F.blush(g, cx - 7, 15); F.blush(g, cx + 6, 15); }; },
  shisa(g, cx, k) { B.mane(g, cx, 'a'); B.feet(g, cx, 'b'); B.round(g, cx, 'b'); B.arms(g, cx, 'b'); return () => { F.brow(g, cx - 5, 9, 1); F.brow(g, cx + 3, 10, -1); F.eye(g, cx - 4, 12, true); F.eye(g, cx + 3, 12, true); F.flat(g, cx, 16); F.fang(g, cx - 2, 17); F.fang(g, cx + 2, 17); }; },
  rakko(g, cx, k) { B.feet(g, cx, 'b'); B.egg(g, cx, 'b'); B.arms(g, cx, 'b'); B.earsRound(g, cx, 'b'); B.facePatch(g, cx, 'a'); B.sword(g, cx); return () => { F.eye(g, cx - 4, 11, k); F.eye(g, cx + 3, 11, k); F.flat(g, cx, 15); }; },
  furuhonya(g, cx, k) { B.feet(g, cx, 'b'); B.round(g, cx, 'b'); B.claws(g, cx, 'b'); B.book(g, cx, 'c'); return () => { F.eye(g, cx - 4, 10, k); F.eye(g, cx + 3, 10, k); F.smile(g, cx, 13); F.blush(g, cx - 7, 12); F.blush(g, cx + 6, 12); }; },
  dekatsuyo(g, cx, k) { B.feet(g, cx, 'b'); B.big(g, cx, 'b'); B.arms(g, cx, 'b', true); B.earsRound(g, cx, 'b'); return () => { F.brow(g, cx - 5, 8, 1); F.brow(g, cx + 3, 9, -1); F.eye(g, cx - 4, 11, k); F.eye(g, cx + 3, 11, k); F.flat(g, cx, 15); F.fang(g, cx - 2, 16); F.fang(g, cx + 2, 16); F.blush(g, cx - 8, 14); F.blush(g, cx + 7, 14); }; },
  pajama(g, cx, k) { B.feet(g, cx, 'b'); B.round(g, cx, 'b'); B.arms(g, cx, 'b'); B.stripes(g, cx, 'a'); B.nightcap(g, cx, 'a'); return () => { F.eye(g, cx - 4, 12, true); F.eye(g, cx + 3, 12, true); F.omega(g, cx, 15); F.blush(g, cx - 7, 14); F.blush(g, cx + 6, 14); }; },
  seiren(g, cx, k) { B.egg(g, cx, 'b'); B.arms(g, cx, 'b'); B.earsCat(g, cx, 'b'); B.fin(g, cx, 'a'); return () => { F.brow(g, cx - 5, 9, -1); F.brow(g, cx + 3, 8, 1); F.eye(g, cx - 4, 11, k, true); F.eye(g, cx + 3, 11, k, true); F.flat(g, cx, 15); }; },
  yoroi_ramen(g, cx, k) { B.feet(g, cx, 'b'); B.round(g, cx, 'b'); B.arms(g, cx, 'b'); B.helmetBand(g, cx, 'w'); return () => { F.band(g, cx, 11); F.gum(g, cx, 15); }; },
  yoroi_info(g, cx, k) { B.feet(g, cx, 'b'); B.round(g, cx, 'b'); B.arms(g, cx, 'b'); B.badge(g, cx, 'c'); return () => { F.band(g, cx, 11); F.gum(g, cx, 15); }; },
  yoroi_pochette(g, cx, k) { B.feet(g, cx, 'b'); B.round(g, cx, 'b'); B.arms(g, cx, 'b'); B.pochette(g, cx, 'a'); B.sword(g, cx); return () => { F.band(g, cx, 11); F.gum(g, cx, 15); }; },
};
export const PIXEL_IDS = Object.keys(DEFS);

// 격자 → 픽셀 색 배열. blink: 눈 감음, silhouette: 전부 회색
export function buildPixels(sp, blink = false, silhouette = false) {
  const def = DEFS[sp.id] ?? DEFS.chiikawa;
  const g = grid();
  const face = def(g, 11, blink);
  outline(g);
  face();
  const pal = { ...FIXED, b: sp.color, a: sp.tone };
  return g.map((row) => row.map((v) => (v ? (silhouette ? '#C9C2B6' : (pal[v.c] ?? v.c)) : null)));
}
const cache = new Map();
function frame(sp, blink, silhouette) {
  const key = `${sp.id}|${sp.color}|${sp.tone}|${blink ? 1 : 0}|${silhouette ? 1 : 0}`;
  let cv = cache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = PW; cv.height = PH;
  const c = cv.getContext('2d');
  const px = buildPixels(sp, blink, silhouette);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) if (px[y][x]) { c.fillStyle = px[y][x]; c.fillRect(x, y, 1, 1); }
  cache.set(key, cv); return cv;
}
// (cx, cy)=하단 중심, size=폭. 정수 배율로 확대해 픽셀이 뭉개지지 않게. opts: { waving, tilt, silhouette, alpha }
export function drawPixel(ctx, sp, cx, cy, size, t, opts = {}) {
  const blink = !opts.silhouette && (t % 3400) < 110;
  const cv = frame(sp, blink, !!opts.silhouette);
  const scale = Math.max(1, Math.floor(size / PW));
  const w = PW * scale, h = PH * scale;
  const wobble = (opts.waving ? Math.sin(t / 60) * 0.08 : 0) + (opts.tilt ?? 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
  const x = Math.round(cx - w / 2), y = Math.round(cy - h);
  ctx.translate(cx, cy); ctx.rotate(wobble); ctx.translate(-cx, -cy);
  ctx.drawImage(cv, x, y, w, h);
  ctx.restore();
  return { w, h };
}

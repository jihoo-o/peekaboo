# ADR-0002: @mediapipe/tasks-vision 0.10.35 고정 (1.0.x 미채택)

- 날짜: 2026-09-15 · 상태: 채택

## 맥락
계획은 "0.10.x 최신 고정". npm 레지스트리 조회 결과 `latest`는 1.0.1이고, 0.10 계열의 마지막 정식 버전은 0.10.35 (그 뒤는 0.10.36-rc.*)였다.

## 결정
`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35` (bundle과 `/wasm` 모두 같은 버전)로 고정한다.

## 이유 (공수)
- 1.0.x는 API 변경 여부를 확인해야 하고, 계획 문서·프롬프트가 0.10.x API(`createFromOptions`, `detectForVideo`, `segment(image, roi, cb)`)를 전제로 한다. 확인 비용 없이 바로 쓸 수 있는 쪽이 0.10.35.
- rc 버전은 배제 (재현성).

## 결과
`app.js`의 `VISION_VERSION` 한 곳만 바꾸면 업그레이드된다.

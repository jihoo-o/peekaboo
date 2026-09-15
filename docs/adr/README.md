# ADR — Peekaboo AR

"가장 빠른 작업 공수"를 기준으로 내린 의사결정만 한 건에 한 파일로 기록한다. 계획 문서(second-brain §0 최단 플랜)에서 이미 정해진 것(2D 캔버스, 무빌드, MediaPipe, 컵 1개 등)은 다시 적지 않는다.

| # | 결정 |
|---|---|
| [0001](0001-single-app-js.md) | app.js 한 파일 유지, 모듈 분리 안 함 |
| [0002](0002-tasks-vision-0.10.35.md) | @mediapipe/tasks-vision 0.10.35 고정 (1.0.x 미채택) |
| [0003](0003-start-button-user-gesture.md) | 카메라를 "카메라 시작" 버튼(사용자 제스처) 뒤에서 시작 |
| [0004](0004-verify-with-fake-camera.md) | 실기기 대신 헤드리스 Chromium + 가짜 카메라(y4m)로 실행 검증 |
| [0005](0005-mask-polarity-by-bbox-iou.md) | 마스크 극성(물체=0/배경=255)을 bbox IoU로 자동 선택 |
| [0006](0006-mask-gate-pixel-loop-main-thread.md) | 마스크 IoU 게이트·EMA를 메인 스레드 픽셀 루프로, 워커 없음 |
| [0007](0007-skip-s6-glb-and-ios.md) | S6(three.js GLB 캐릭터, iOS 확인) 미수행 |
| [0008](0008-pages-no-workflow.md) | GitHub Pages 워크플로 없이 브랜치 루트 서빙 |
| [0009](0009-canvas-filter-blur.md) | 마스크 페더링을 `ctx.filter = blur(2px)`로 |
| [0010](0010-drawn-character-no-png.md) | 캐릭터를 캔버스 드로잉으로, PNG 에셋 없음 |

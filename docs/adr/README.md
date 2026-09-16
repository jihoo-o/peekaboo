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
| [0008](0008-pages-no-workflow.md) | ~~GitHub Pages 워크플로 없이 브랜치 루트 서빙~~ → 대체: Pages 자동 배포 워크플로(enablement) |
| [0009](0009-canvas-filter-blur.md) | 마스크 페더링을 `ctx.filter = blur(2px)`로 |
| [0010](0010-drawn-character-no-png.md) | 캐릭터를 캔버스 드로잉으로, PNG 에셋 없음 |
| [0011](0011-home-object-by-class-label.md) | "최초 인식 물체"를 클래스 라벨 하나로 기억 (localStorage) |
| [0012](0012-collection-by-candy-color.md) | 수집 게임: 별사탕 색 6종이 캐릭터 정체성, 5초 유지 후 등장 |
| [0013](0013-scan-then-random-target-and-glow.md) | 스캔 후 대상 물체 무작위 선택·저장, 가까움 = bbox 폭, 발광 = lighter 합성, 짠! 등장 |
| [0014](0014-targetable-all-but-excluded.md) | 타깃 가능 클래스 = COCO 전부에서 사람·동물·탈것·거리 시설물·큰 면만 제외 |
| [0015](0015-side-placement-and-solved-skip.md) | 위 여유 없으면 옆에서 등장(좌우 여유 비교), 맞춘 물체는 solved 저장 후 즉시 등장 |
| [0016](0016-sneak-out-instead-of-pop.md) | 짠! 대신 스을쩍: 완전히 가려진 위치에서 2.4초 스니크 곡선(움찔 포함)으로 걸어 나옴 |
| [0017](0017-parallax-from-frame-offset.md) | 패럴랙스: 물체의 화면 내 치우침으로 숨은 캐릭터를 더 드러냄(자이로·포즈 없음), 휴식 자세는 반쯤 숨김 |
| [0018](0018-chiikawa-dex-and-skin-slot.md) | 먼작귀 도감: 종 15개, 물체 라벨별 등장 규칙 + 희귀도 가중치, 심야 시크릿, 세트, 공식 에셋 슬롯(없으면 이름표 실루엣) |

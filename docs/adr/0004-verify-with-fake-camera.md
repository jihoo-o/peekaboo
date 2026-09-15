# ADR-0004: 실기기 대신 헤드리스 Chromium + 가짜 카메라로 실행 검증

- 날짜: 2026-09-15 · 상태: 채택

## 맥락
작업 환경은 폰이 없는 원격 컨테이너다. 그래도 "결과물 실행까지 완결"이 요구됐다. 추가 제약: 컨테이너에서 `cdn.jsdelivr.net`과 `upload.wikimedia.org`는 프록시가 차단, `registry.npmjs.org`·`storage.googleapis.com`·`pypi.org`는 열려 있었다.

## 결정
Playwright(Chromium)로 페이지를 실제로 구동한다.
- 카메라: `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=cup.y4m`. 프레임은 scikit-image 휠에 들어 있는 실제 커피잔 사진(`coffee.png`)을 480×640 세로 프레임으로 만든 y4m(직접 작성한 I420 writer).
- CDN: `page.route`로 `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/**`를 npm에서 받은 같은 버전 패키지 파일로 응답. 모델 URL도 미리 받은 파일로 응답.
- 앱 코드는 변경하지 않는다(라우팅은 테스트 측에서만). 검증 스크립트는 레포에 넣지 않고 결과 스크린샷만 `docs/verify/`에 남긴다.

## 이유 (공수)
- 앱에 "로컬 라이브러리 경로" 옵션을 넣는 것보다 라우팅이 코드 변경 0줄.
- 컵 사진을 구하는 가장 빠른 경로가 pypi의 scikit-image 샘플 데이터였다(허용 호스트, 실제 사진, COCO `cup`으로 0.69 검출됨).
- 검증 스크립트를 레포에 넣으면 의존성(playwright, http-server)과 경로 정리가 필요해져 무빌드 원칙과 충돌한다.

## 결과
- 확인된 것: 검출·락·peek/idle·마스크 오클루전·탭 wave·셔터 다운로드.
- 확인 안 된 것: 실기기 Hz(컨테이너는 SwiftShader라 1~2Hz), `navigator.share`, 발열, 실제 손떨림에서의 스무딩. README "아직 폰에서 확인 안 된 것"에 기록.

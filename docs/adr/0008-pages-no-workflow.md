# ADR-0008: GitHub Pages 워크플로 없이 브랜치 루트 서빙

- 날짜: 2026-09-15 · 상태: 채택

## 맥락
배포는 GitHub Pages. 선택지는 (a) Settings에서 "Deploy from a branch"를 사람이 켜기, (b) `actions/deploy-pages` 워크플로 추가.

## 결정
(a). 워크플로 파일을 만들지 않는다. 계획의 "사전 준비(사람이 5분)"대로 사용자가 Pages 소스를 지정한다.

## 이유 (공수)
- (b)도 Settings에서 소스를 "GitHub Actions"로 바꾸는 수동 단계가 똑같이 필요하다. 워크플로는 파일만 늘리고 수동 단계를 없애지 못한다.
- 빌드가 없으니 브랜치 루트를 그대로 서빙하는 것으로 충분하다.

## 결과
- 이 작업 브랜치(`claude/peekaboo-ar-shortest-plan-0h74bf`)를 `main`에 머지한 뒤 Pages를 `main / (root)`로 두거나, 머지 전에 확인하려면 Pages 소스를 이 브랜치로 잠시 지정한다.
- Pages URL은 `https://<id>.github.io/peekaboo/` (레포명이 계획의 `peekaboo-ar`가 아니라 `peekaboo`).

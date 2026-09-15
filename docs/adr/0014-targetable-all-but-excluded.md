# ADR-0014: 타깃 가능 클래스 = COCO 80종 전부에서 제외 목록만 뺀다

- 날짜: 2026-09-15 · 상태: 채택

## 맥락
실기기에서 "컵만 인식된다"는 피드백. S2의 `ALLOWED` 8종(cup, bottle, book, bowl, vase, potted plant, mouse, laptop)이 스캔·락 모두를 제한하고 있었다. 요청은 "바닥(면) 위에 놓인 물체는 전부 타깃 가능".

## 결정
허용 목록을 없애고 **제외 목록**만 둔다: 사람·동물 11종, 탈것 8종, 거리 시설물 4종, 화면을 거의 다 덮는 큰 면(dining table, bed) 2종. 나머지 55종은 스캔 대상이자 락 대상이다. 기존 호출부는 `ALLOWED.includes(label)` 그대로 두고 `ALLOWED = { includes: isTargetable }`로 바꿔 변경 범위를 상수 한 곳으로 줄였다.

## 이유 (공수)
- "면 위에 놓이는가"를 기하학적으로 판단(바닥 인식)하는 건 §0에서 미룬 항목이다. 클래스 이름으로 나누는 게 코드 몇 줄.
- 허용 목록을 늘리는 방식은 실기기에서 빠진 클래스가 나올 때마다 수정이 필요하다. 제외 목록은 움직이는 것(사람·동물·탈것)과 큰 면만 걸러 주면 나머지는 자연히 "놓인 물체"다.

## 결과
- chair, couch, tv, backpack, suitcase, remote, keyboard, cell phone, clock, teddy bear, 음식류 등도 모두 스캔에서 보이고 무작위 대상 후보가 된다.
- 큰 물체(couch, refrigerator)가 대상이 되면 발광 반경이 화면을 덮을 수 있다. 어색하면 EXCLUDED에 추가.

# ADR-0007: S6(three.js GLB 캐릭터, iOS 확인) 미수행

- 날짜: 2026-09-15 · 상태: 채택

## 맥락
S6는 계획에서 "(선택)"이다. 내용은 (1) CC0 GLB 캐릭터를 three.js로 렌더해 합성, (2) iPhone Safari에서 동작 여부 기록.

## 결정
둘 다 하지 않는다. S5까지를 완결로 본다.

## 이유 (공수)
- (1) GLB 에셋(Quaternius/Kenney)을 받으려면 컨테이너에서 차단된 호스트에 접근해야 하고, three.js 오프스크린 캔버스 + 애니메이션 매핑은 3D 없이 증명하려던 §0의 취지와 반대다. 현재 캔버스 캐릭터가 "물체 뒤에서 나타난다"는 핵심 검증에 충분하다.
- (2) iOS 기기가 없다. 기록할 수 있는 사실이 없다.

## 결과
- 캐릭터 교체 지점은 `drawCharacter(ctx, cx, cy, size, t, waving)` 한 함수. three.js 도입 시 이 함수만 `drawImage(glCanvas, ...)`로 바꾸면 된다.
- iOS는 사용자가 폰으로 URL을 열어 카메라 권한·검출 여부만 README에 적으면 된다. 알려진 주의점: `playsinline`·`muted`(적용됨), `ctx.filter` 미지원 시 블러만 빠지고 마스크는 동작.

# 먼작귀 공식 에셋 슬롯

라이선스 계약 후 권리자(스파이럴큐트 / 대원미디어)에게서 받은 공식 그림을 여기에 넣는다. 파일이 없으면 앱은 종의 색과 이름표만 있는 실루엣을 그린다. 이 폴더에는 팬메이드 그림을 넣지 않는다.

- 파일명: `<species.id>.png` (`app.js`의 `SPECIES` 참고: `chiikawa.png`, `hachiware.png`, `usagi.png`, `momonga.png`, `kurimanju.png`, `shisa.png`, `futaba.png`, `anko.png`, `rakko.png`, `kani.png`, `pajama.png`, `seiren.png`, `yoroi_ramen.png`, `yoroi_info.png`, `yoroi_kusa.png`)
- 형식: 투명 배경 PNG, 정면, 발끝이 이미지 하단에 닿게(하단 중심 정렬로 그린다), 폭 512px 안팎
- `manifest.json`: 실제로 넣은 id의 배열. 여기 적힌 파일만 로드한다. 예: `["chiikawa", "hachiware", "usagi"]`
- 확인: `?skin=none`으로 열면 스킨을 무시하고 실루엣만 그린다

# 먼작귀 원본 에셋 슬롯

협업(라이선스) 조건상 캐릭터는 **재생산이 아니라 권리자에게서 받은 원본 그림을 그대로** 쓴다. 이 폴더에 파일을 넣고 `manifest.json`에 적으면 앱이 그 그림을 그린다. 파일이 없는 종만 캔버스 드로잉(`drawSpecies`)으로 대체된다. 팬메이드 그림은 넣지 않는다.

## 폰에서 바로 넣기 (저장소에 올리지 않음)
앱의 ★ 도감 패널 → **원본 그림 넣기** → 파일 선택. 같은 파일명 규칙(`<id>.png`, `<id>_wave.png`)이고, 그 기기의 IndexedDB에만 저장된다. 라이선스 전 시연은 이 방법을 쓴다.

## 파일 사양 (권리자에게 요청할 것)
- 종 14개, 각각 `<species.id>.png` — `chiikawa`, `hachiware`, `usagi`, `momonga`, `kurimanju`, `shisa`, `rakko`, `furuhonya`, `dekatsuyo`, `pajama`, `seiren`, `yoroi_ramen`, `yoroi_info`, `yoroi_pochette`
- 투명 배경 PNG(또는 WebP, `file`로 지정), **정면**, **발끝이 이미지 하단에 닿게**(앱이 하단 중심 정렬로 그린다), 좌우 여백은 최소로, 폭 512~1024px
- 선택: `<id>_wave.png` — 손 흔드는 포즈. 있으면 탭했을 때 자동으로 교체된다(없으면 원본을 좌우로 흔든다)

## manifest.json
실제로 넣은 항목만 적는다(적힌 파일만 로드한다). 문자열 또는 객체:
```json
[
  "chiikawa",
  { "id": "hachiware", "scale": 1.2 },
  { "id": "usagi", "file": "usagi_v2.webp", "wave": "usagi_wave_v2.webp", "dy": 0.05 },
  { "id": "momonga", "wave": false }
]
```
- `scale`: 폭 배율(기본 1.1 = bbox 기준 캐릭터 폭의 1.1배). 귀·꼬리가 넓은 그림은 키운다
- `dy`: 하단 기준 세로 오프셋(폭 대비 비율, 양수 = 아래로). 발 아래 여백이 있는 그림은 양수
- `wave`: 흔들기 그림 파일명. `false`면 `<id>_wave.png`를 찾지 않는다

## 확인
- HUD 마지막 줄 `skin n/14`가 로드된 수. 콘솔에 `skin missing <id>`가 뜨면 파일명이 다르다
- `?skin=none`: 원본 무시하고 캔버스 드로잉, `?skin=silhouette`: 이름표 실루엣
- 도감 패널 썸네일과 공유 사진에도 같은 그림이 쓰인다

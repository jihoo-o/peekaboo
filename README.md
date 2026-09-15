# Peekaboo AR — a character hiding behind objects

Point your phone camera at a cup, hold still for five seconds, and a soot sprite peeks out from **behind** it. Tap it to collect it — there are six candy colors to find.
No build step: just `index.html` + `app.js`. Libraries come from a CDN as ES modules and the models load straight from Google's storage.

- Detection: MediaPipe ObjectDetector (EfficientDet-Lite0 fp16, COCO 80 classes)
- Occlusion: MediaPipe InteractiveSegmenter (MagicTouch) mask clips the video and is drawn over the character
- Tracking: lock the largest allowed-class detection → IoU matching → One Euro filter smoothing

## Run it

1. **GitHub Pages**: every push to `main` deploys via `.github/workflows/pages.yml` → open `https://jihoo-o.github.io/peekaboo/` in Android Chrome.
   Pages is not available for private repos on the free plan. Make the repo public first (Settings → General → Danger Zone → Change visibility), then trigger `pages` from the Actions tab.
2. **Local**: `npx serve .` and expose it over HTTPS (for example `cloudflared tunnel --url http://localhost:3000`). Camera permission is only granted on HTTPS or localhost.
3. Tap **카메라 시작** (start camera) → center a cup in the frame. The first object that gets a confirmed lock is remembered in `localStorage` and only that class triggers the character from then on. Hold it steady for 5 s (soot particles rise and a progress ring fills) and the sprite slowly peeks out.
4. Tap the sprite: an uncollected one (shows a yellow "!") is added to your collection; an already collected one (holding a candy) just wiggles. The ★ badge at the top right opens the collection panel, which also has a reset button. The shutter button at the bottom shares or saves the composited image.

### URL query parameters

| Query | Effect |
|---|---|
| `?res=480` | Lower the camera input to 640×480 (use when detection is below 10 Hz) |
| `?mask=0` | Disable segmentation and use the S3 rectangular bbox occlusion only |
| `?debug=0` | Hide detection boxes and labels (the HUD stays on) |
| `?reset=1` | Forget the remembered object and clear the collection |

HUD (top-left): detection Hz · segmentation Hz · render fps · delegate · locked class · miss time · character state · mask state.

## Stages (see the `S1`–`S5` comments in the code and the commit history)

| Stage | What | Commit |
|---|---|---|
| S1 | Camera + ObjectDetector loop + HUD | `S1: camera + object detection` |
| S2 | Target lock + IoU matching + One Euro filter | `S2: target lock + one euro filter` |
| S3 | 2D character peek/idle/hide + rectangular bbox occlusion | `S3: character peek with bbox occlusion` |
| S4 | InteractiveSegmenter mask occlusion (EMA, blur, IoU gate) | `S4: segmentation mask occlusion` |
| S5 | Tap → wave, shutter → Web Share / download, hint text | `S5: tap reaction + share` |
| S6 | (optional) three.js GLB character, iOS check — **not done**, see [ADR-0007](docs/adr/0007-skip-s6-glb-and-ios.md) | — |
| S7 | Game: remember the first confirmed object, 5 s hold → slow peek, soot-sprite character, tap to collect, collection panel ([ADR-0011](docs/adr/0011-home-object-by-class-label.md), [ADR-0012](docs/adr/0012-collection-by-candy-color.md)) | `S7: collection game` |

## Verification (headless Chromium + fake camera)

Without a phone at hand, the page was actually run under Playwright ([ADR-0004](docs/adr/0004-verify-with-fake-camera.md)). The fake camera feed is scikit-image's sample `coffee.png`, a real photo of a coffee cup.

| S1 detection | S3 bbox occlusion | S4 mask occlusion | S7 collected sprite |
|---|---|---|---|
| ![](docs/verify/s1-detection.png) | ![](docs/verify/s3-bbox-occlusion.png) | ![](docs/verify/s4-mask-occlusion.png) | ![](docs/verify/s7-collected.png) |

- Confirmed: `cup` detected at 0.69 and locked, `cup` remembered after 3 consecutive matches, charging → peek → idle, the mask hides the sprite along the cup's curved rim, first tap → `collect` (collection 1/6 persisted in localStorage), second tap → `wave`, shutter → `peekaboo-<ts>.jpg` download.
- The container renders WebGL in software (SwiftShader), so detection ran at 1–2 Hz there. **Real-device Hz must be checked on a phone.** Use `?res=480` if it is below 10 Hz.

## Not yet verified on a phone

- Detection / segmentation Hz, heat, and mask flicker on real Android Chrome (if flicker is bad, set `MASK_EMA` in `app.js` to 0.7).
- The `navigator.share` file-sharing path (headless only exercised the download fallback).
- iOS Safari.

## Decision records

`docs/adr/` — one ADR per decision made on a "fastest effort" basis.

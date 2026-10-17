# ZKP-CerebraChain frontend

React implementation of the supplied Google Stitch **single-page** export. The original `../stitch/DESIGN.md`, `code.html`, and `screen.png` are retained byte-for-byte. Existing backend files and the root Node package are unchanged.

## Ubuntu setup

Use **Node.js 22.12 or newer** and npm. From your Ubuntu project directory:

```bash
cd "/home/vishesh/hackethon projects/ZKP Phaltan/mypro"
cd frontend
npm install
npm run dev
```

Open **http://127.0.0.1:5173/**. The default is a clearly labeled design demonstration and needs no backend, model, dataset, wallet, or cloud credentials. Vite binds to loopback and refuses to silently change ports; stop another service occupying 5173 or explicitly choose a different port with `npm run dev -- --port 5174`.

```bash
npm run build
npm run preview
```

The production preview runs at **http://127.0.0.1:4173/**. Build output is `dist/`. A static production host must serve `dist/` and reverse-proxy `/api` to the existing trust layer; Vite’s proxy is for local development/preview only.

## Design and interactions

- Preserves the exported dark HUD layout, cyan/purple/green palette, background dot grid, glass panels, typography, and all seven sections. No additional application pages were invented.
- Locally bundled Inter, Space Grotesk, and JetBrains Mono fonts; Lucide replaces the export’s remote icon font. There are no required Google/CDN asset calls at runtime.
- Responsive section navigation, mobile menu with Escape support, current-section highlighting, skip link, keyboard focus outlines, and native modal focus management.
- React Three Fiber particle brain based on the supplied procedural illustration, including tumor/synapse/weight modes, drag rotation, pinch/wheel zoom, keyboard-operable camera buttons, and camera reset. It is **not anatomical patient data**. Rendering pauses off-screen; reduced-motion preference disables automatic rotation. A static fallback handles renderer errors.
- Animated protocol workflow, sample hospital cards, demonstration curves with speed/play/pause controls, four modality selectors, opacity control for all three schematic masks, proof-animation sequence, selectable ledger cards, real clipboard copying with failure feedback, and a nine-stage educational tour.
- Motion honors the OS reduced-motion preference. User-triggered simulation steps still advance; the tour never autoplays on page load.

The screenshot shows a blank brain viewport. Its export contains duplicate `const container` declarations that prevent its legacy Three.js script from executing. The React version supplies the intended illustration while preserving the surrounding design. Unverified claims about privacy budgets, compliance certification, measured confidence, clinical validation, and proof validity have been replaced with honest labels; they were design copy, not evidence of those capabilities.

## Existing backend integration

Select **Live trust layer** in the data-source control. The frontend calls only the existing **`GET /api/state`**, initially and every five seconds after the previous request completes. Requests time out after eight seconds, are canceled on mode changes/unmount, and never overlap. Invalid responses or connection failures clear live values and show an error; they never substitute demo hospital/metric/ledger values.

The default Vite proxy target is `http://127.0.0.1:8787`. To use a different existing service:

```bash
TRUST_LAYER_URL=http://127.0.0.1:8787 npm run dev
```

Alternatively copy `.env.example` to `.env.local`, set `TRUST_LAYER_URL`, and restart Vite. Do not put private keys or credentials in frontend variables.

The existing read API supplies registered hospitals, hospital-reported round validation metrics, proof submission outcomes, circuit metadata, chain connection metadata, and finalization block/model hashes. Charts keep hospital values separate and retain missing values as gaps; no global Dice or model architecture is inferred. Zero-valued measurements remain zero. Proof outcomes and blocks are explicitly described as **backend-reported**, without independent browser verification. The backend calls its artifact a global model hash, so the UI does not relabel it a Merkle root.

Live mode disables demo aggregation/proof actions. The brain, MPR panes, workflow, and tour retain their own illustration/demo labels in either mode. The root backend is Express, not FastAPI, in this checkout. The hospital-local MRI viewer remains separate and is not proxied by this central dashboard.

**Still requires integration:** teammate’s 3D model, actual MRI loading/multiplanar reconstruction, patient inference, DICOM/PACS, authentication, hardware-enclave attestations, privacy accounting, and authenticated job/transaction controls. No new model, training, federated logic, ZK circuit, or smart-contract changes were made.

## Verification

```bash
npm test
```

The Playwright configuration uses `CHROMIUM_PATH` if set, or Ubuntu’s `/usr/bin/chromium` if installed. Otherwise install Playwright’s browser once:

```bash
npx playwright install --with-deps chromium
npm test
```

Browser tests cover assets/runtime errors, desktop/mobile navigation, 320/390/768/1024/1440px layouts, camera controls, modality and mask opacity, workflow/tour controls, labeled proof animations without mutations, API fixture success including numeric zero, API failure and schema/empty states, clipboard copying, dialogs, and reduced motion. API fixtures are confined to tests; they are not used as a live fallback.

The Three.js rendering chunk is approximately 893 kB minified (239 kB gzip), which produces Vite’s standard chunk-size warning. It is dynamically imported with the brain viewer; the main UI does not depend on successful WebGL rendering. No medical inference or clinical performance has been validated by frontend tests.

## Source map

- `src/App.tsx`, `main.tsx`, `styles.css`: page composition, fonts, and design system.
- `src/components/`: header, hero/brain canvas, workflow, federation telemetry, workstation, proof lab, ledger, simulator, and shared controls/dialogs.
- `src/lib/`: typed read-API adapter, response validation, and polling/data-source context.
- `tests/frontend.spec.ts`, `playwright.config.ts`: browser verification.
- `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `postcss.config.js`, `index.html`, `.env.example`, `.gitignore`: standalone frontend setup.

Dependencies: React, React DOM, TypeScript, Vite, Tailwind CSS/PostCSS/Autoprefixer, Motion, Three.js, React Three Fiber, Lucide React, three Fontsource packages; Playwright and type packages for development.

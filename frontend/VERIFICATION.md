# Frontend verification — 2026-10-17

Measured in the managed Linux workspace at `/workspace/backend-review/zkp-cerebrachain/frontend`, using Node.js 24.19.0, npm 11.9.0, and system Chromium.

- `npm install --cache /workspace/work/stitch-integration/npm-cache`: completed. The explicit cache path was needed because this sandbox's default home cache is not writable; a normal Ubuntu installation uses `npm install`.
- `npm run build`: passed TypeScript checking and production bundling with Vite 7.3.7. There is a standard warning for the large Three.js rendering chunk: 893.00 kB minified / 239.00 kB gzip.
- `npm test`: **13 passed in 49.6 seconds**. Tests include assets, navigation, mobile controls, actual camera-render changes, workflow/tour advancement, proof animations without mutations, API success/failure/invalid/empty fixtures, zero metrics, clipboard, dialogs, reduced motion, horizontal-overflow checks, and unavailable-WebGL fallback.
- Browser widths checked: **320, 390, 768, 1024, 1440 px**. No horizontal overflow after the header adjustment.
- `npm audit --omit=dev`: **0 reported production dependency vulnerabilities** at verification time.
- Actual Express backend started temporarily on loopback **18787**, with `CHAIN=off` and storage under `/workspace/work/stitch-integration/`. No training or existing storage was used. Production preview on **4173** proxied `GET /api/state` successfully: HTTP **200**, **0 hospitals**, **0 rounds**, blockchain **disabled**, circuit chunk size **4096**. The rendered UI showed the real empty state; it did not fabricate registered hospitals or round metrics. Populated live states were checked using explicit test-only fixtures.
- Production browser smoke check: **0 page errors**, **0 failed requests**. Local fonts and lazy-loaded viewer rendered successfully. Screenshots were inspected at desktop and mobile sizes.
- All **3 Stitch files** were compared with the uploaded ZIP and match byte-for-byte.
- Hashes of **51 existing backend/protected setup files** match their pre-implementation values. No existing source files were modified; additions are confined to `frontend/` and the extracted `stitch/` export.

Development startup was confirmed at **http://127.0.0.1:5173/**. Test-owned servers are stopped after verification; start your own instance with the README commands.

No model was created/trained and no medical inference, Flower run, proof generation, blockchain transaction, or patient data transfer was performed. Frontend browser tests establish interface behavior, not medical validity or security certification.

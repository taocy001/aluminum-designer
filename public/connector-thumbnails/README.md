These 168 × 168 PNGs are orthographic projections of the complete meshes returned by `connectorMeshes`. The picker covers all 14 connector types in series 20, 30 and 40. Its series 20 icons use the same default as `ConnectorThumbnail`; the other series retain their own geometry and mounting screw positions.

Generate them from the repository root with:

```sh
node scripts/generate-connector-thumbnails.mjs
node scripts/generate-connector-thumbnails.mjs --check
```

Generation uses the project's installed Vite and Playwright dependencies. Chromium must be installed (`npx playwright install chromium`). The TypeScript loader runs without an HTTP listener; Canvas 2D renders the same projection, shading and strokes used by the generation script. No model vertices are removed or simplified. Canvas previews, collision checks and CAD exports continue to use the full meshes.

`src/assets/connectorThumbnails.json` records each PNG's SHA-256 and the hashes of the generator, its local runtime dependencies, CAD inputs and dependency lockfile. The check command and unit tests reject outdated sources, missing images and changed image contents. Image names include their content hash for browser caching. Changes to geometry, projection or dependencies require regeneration.

Manufacturer-derived images retain the attributions and limitations documented in `src/assets/connectorCad/README.md` and `docs/CONNECTOR-ACCESSORIES.md`.

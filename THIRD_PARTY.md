# Third-party software

| Package | Licence | Use |
|---|---|---|
| OpenCascade Technology (via `replicad-opencascadejs`) | LGPL-2.1 with OCCT exception | B-rep geometry kernel (WebAssembly) |
| `replicad` | MIT | JavaScript API over OpenCascade |
| `three` | MIT | WebGL rendering, mesh loaders/exporters |
| `jspdf` | MIT | PDF export |
| `opentype.js` | MIT | font parsing |
| `vite` (dev only) | MIT | build tool |

The OpenCascade WebAssembly binary is used unmodified and loaded as a separate file
(`assets/replicad_single-*.wasm`), so it can be replaced by another build of the library, as the LGPL
requires. Its source: https://github.com/Open-Cascade-SAS/OCCT and https://github.com/sgenoud/replicad.

The fonts under `public/fonts` are user-supplied assets and are not covered by the MIT licence of this
repository; see the note in README.md.

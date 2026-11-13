# SOQUA design

Open-source parametric 3D CAD that runs entirely in the browser – desktop, tablet or phone. Nothing is
installed and nothing is uploaded: the geometry kernel (OpenCascade, compiled to WebAssembly) runs on
your own device.

The interface follows the workflow mechanical designers already know: a CommandManager ribbon, a
FeatureManager design tree with rollback, a PropertyManager with live preview, sketches on planes and
faces, and a drawing sheet with a title block.

> SOQUA design is an independent project written from scratch. It contains no code from, and is not
> affiliated with or endorsed by, Dassault Systèmes SOLIDWORKS, Autodesk, PTC, Trimble or any other
> CAD vendor. Product names are trademarks of their owners and are used only to describe file
> compatibility.

## What works today

| Area | Capabilities |
|---|---|
| **Sketch** | Line, centerline, corner/center rectangle, circle, 3-point and centerpoint arc, polygon, slot, spline, point, text (any TTF/OTF font, incl. Mongolian Cyrillic). Snapping and automatic relations, 14 relation types solved by a real geometric constraint solver, driving smart dimensions, drag-to-solve, under/fully-defined status, trim, sketch fillet and chamfer, offset, mirror, linear/circular pattern, convert entities, construction geometry, insert DXF/SVG. |
| **Features** | Extruded boss/cut (blind, mid-plane, through all, two-direction, draft, thin wall), revolved boss/cut, swept boss/cut, lofted boss/cut, hole wizard (simple, counterbore, countersink), helix/spiral paths (springs, coils), real helical threads, cut with plane, fillet, chamfer, shell, draft, linear/circular pattern, mirror, reference planes, 3D sketch, scale, move/copy body, primitives. Full history: edit, suppress, roll back, reorder by deleting/re-adding, undo/redo. |
| **Surfaces** | Extruded, revolved, swept, lofted, planar and offset surfaces, knit, thicken, delete body. |
| **Sheet metal** | Base flange (plate or open profile), edge flange with bend radius, K-factor bend allowance, flat pattern with bend lines, flat-pattern DXF. |
| **Weldments** | Structural members along 2D or 3D sketch lines (square/rectangular tube, pipe, angle, flat, C channel, I beam, round/square bar) with automatic mitres, cut list with CSV export. |
| **Mesh modeling** | Import mesh bodies, decimate, smooth, scale/move/rotate, flip normals, watertight check, mesh → solid, solid → mesh. |
| **Evaluate** | Measure (length, radius, area, minimum distance, angle), mass properties, section view, geometry check, bounding box, materials library. |
| **Simulation** | Linear static stress study (fixtures, forces, gravity) with von Mises and displacement plots, deformed shape and factor of safety. Validated against beam theory (see `tests/fea.test.mjs`). |
| **Render** | Physically based appearances and procedural textures, per-face colours, scene/background, floor shadows, high-resolution PNG output. |
| **Drawing** | Sheet formats (title blocks), standard 3 view (first or third angle), any model view with hidden-line removal, per-view scale, smart dimensions, notes, centre marks, title-block properties. Vector export to **PDF** (font embedded), **DXF** and **SVG**. |
| **Viewport** | Z-up model space, named reference planes that glow on hover, glowing selection, build flash, turntable, animated simulation results; all motion can be switched off. |
| **Devices** | Mouse, trackpad and touch (one finger rotates, two fingers pan/zoom), responsive layout, installable as a PWA and usable offline after the first load. |

### File formats

| Format | Import | Export |
|---|---|---|
| STEP (.step, .stp) | exact B-rep | exact B-rep |
| BREP (.brep) | exact | exact |
| IGES (.igs, .iges) | curves (as a 3D sketch) | wireframe (model edges) |
| STL, 3MF, OBJ, PLY, glTF/GLB | mesh | mesh |
| COLLADA (.dae), FBX | mesh | – |
| DXF | into a sketch | sketches, face outlines, flat patterns, drawings |
| SVG | into a sketch | drawings |
| PDF | – | drawings |
| TTF / OTF fonts | yes | – |
| `.soqua` | native document with full feature history | same |

**Not possible, and why.** `.sldprt` / `.sldasm` (SOLIDWORKS), `.prt` (Creo, NX), `.dwg` (AutoCAD),
`.skp` (SketchUp), `.ipt`, `.x_t` and similar are closed, proprietary formats. No open-source program
can reliably read or write them, and SOQUA design does not pretend to. Exchange exact solids through
**STEP** (every CAD system opens it and it is not a mesh), 2D through **DXF**, and SketchUp models
through **COLLADA/OBJ**.

## Honest limitations

This is a young project, not a replacement for a commercial CAD seat with decades of development.

- Parts only – there is no assembly or mating environment yet.
- Faces and edges are re-found after a rebuild by geometric matching, not by a persistent naming
  scheme, so large upstream edits can make a fillet or shell lose its reference (it is flagged in the
  tree and you re-pick).
- Sketch profiles must be clean closed contours; crossing/overlapping regions are not auto-split.
- Sheet metal flat patterns cover a base plate with edge flanges attached directly to it.
- Simulation uses a voxel mesh: good for sizing and comparing designs, not for certification. Thin
  walls need a high mesh density; peak stresses at sharp corners are mesh dependent.
- Rendering is real-time PBR, not a path tracer.
- IGES surfaces/solids are not read (use STEP).
- Drawing dimensions are placed on projected geometry and are not yet associative to model changes.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:5173. Build a static site with `npm run build` (output in `dist/`), and run the
unit tests with `npm test`.

## Hosting

**Live app: https://sodoo-tx.github.io/soqua-cad/**

The repository is public and every push to `main` is tested, built and deployed to GitHub Pages by
`.github/workflows/deploy.yml`. The app uses relative paths, so a fork works at
`https://<user>.github.io/<repo>/` after setting **Settings ▸ Pages ▸ Source: GitHub Actions**.

The page asks search engines not to index it (`noindex`), so in practice it is reached through the
link. To restrict access to invited people instead, make the repository private and host `dist/` on
Cloudflare Pages with Cloudflare Access, or on Netlify (`netlify.toml` is included).

## Sheet formats and fonts

- Sheet formats live in `public/templates/*.json` (generic A3/A4 title blocks, Mongolian and ISO
  layouts, no company data). To add your own: save a drawing that uses your sheet format as DXF, put
  it in `user-assets/templates/` and run `npm run templates`. That folder is git-ignored, but the
  converted files in `public/templates` are published with the site – check them for names, company
  details and logos before committing.
- Fonts live in `public/fonts`. Users can import any TTF/OTF at runtime (**File ▸ Fonts**); imported
  fonts stay in their browser.

`public/fonts/isocpeu_mon.ttf` / `isocpeui_mon.ttf` are ISOCPEUR-derived fonts, which are normally
licensed with CAD software rather than for redistribution. If you do not have the right to publish
them, remove them – the app falls back to a system font and each user can import their own.

## Project layout

```
src/kernel.js            OpenCascade wrapper (wires, solids, fillets, projection, STEP…)
src/doc.js               parametric document: feature list → bodies, undo/redo, save/load
src/sketch/              constraint solver, profile detection, interactive sketcher
src/features/            feature dialogs, sheet metal, weldments, evaluate/render/simulation/mesh tools
src/drawing/drawing.js   drawing sheets, views, dimensions, PDF/DXF/SVG export
src/io/                  DXF reader/writer, IGES reader, importers and exporters
src/sim/fea.js           voxel finite-element solver
src/view/viewport.js     three.js viewport, navigation, picking
src/ui/                  ribbon, menus, PropertyManager, icons
tests/                   node tests (solver, FEA, DXF, kernel and feature-engine smoke tests)
```

## Licence

SOQUA design is released under the [MIT licence](LICENSE). It depends on OpenCascade Technology via
`replicad-opencascadejs` (LGPL-2.1), `replicad` (MIT), `three.js` (MIT), `jsPDF` (MIT) and
`opentype.js` (MIT); see `THIRD_PARTY.md`.

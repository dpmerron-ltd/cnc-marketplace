# Sheet Builder

Local-first MVP for arranging pre-generated Estlcam CNC G-code files on a sheet and exporting one combined G-code program.

The app treats individual `.nc`, `.tap`, `.gcode`, or `.cnc` files as reusable machining assets. It does not regenerate CAM toolpaths. It parses the existing G-code, normalizes the part footprint, transforms XY coordinates for placement and 0/90/180/270 degree rotation, and exports one combined program with global start/end G-code and safe Z transitions.

## Run

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, usually:

```text
http://127.0.0.1:5173/
```

## Verify

```bash
npm test
npm run lint
npm run build
```

## Supabase Setup

Sign-in and MFA use Supabase. Each account has its own private item library and browser backup.

1. Open Supabase SQL Editor.
2. Run `supabase/schema.sql`.
3. Restart the app.

For local development, copy `.env.example` to `.env.local` and set:

```bash
VITE_SUPABASE_URL=https://bsnndtwbvgrthddmbhoa.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

The current MVP stores G-code and optional DXF text in Postgres rows. Row-level security restricts items, components, sheet projects, history, and presets to their owner. Components must also belong to an item owned by that account. Existing data stays with its recorded owner; unowned legacy records are not automatically assigned or exposed.

Browser backups are keyed by account ID. The old shared browser cache is never automatically loaded. Explicit project-file imports create independent copies with new IDs in the importing account. Saved placements referencing another account's components are removed when loaded.

The Pages deployment applies `supabase/schema.sql` transactionally before publishing the frontend, using the `SUPABASE_DB_URL` repository secret. A failed schema migration blocks publication.

## MVP Features

- Import individual Estlcam-style G-code files.
- Optionally import same-stem DXF files alongside G-code; DXF text is associated and stored, with polygon parsing reserved for Phase 2.
- Build a reusable in-browser part library.
- Place multiple independent instances of the same part.
- Drag, select, duplicate, delete, lock, and set exact X/Y/rotation values.
- Default 1220 x 1220 mm sheet with editable width, height, and spacing.
- Basic shelf auto-nesting for unlocked parts.
- SVG preview generated from the same transformed representation used for export.
- Collision and out-of-sheet validation.
- Automatic spindle-off maximum X/Y reach check for the parts on each physical sheet.
- Optional screw-position marks, off by default, with a spindle-off pause before component machining.
- Safe Z clearance override enabled at 20 mm by default, without changing source cutting depths or feeds.
- Export one combined `.nc` program.
- Save/load from browser local storage.
- Export/import a JSON project backup.

## Architecture

- `src/gcode/parser.ts`: word-level parser with modal motion tracking for Estlcam-style G-code.
- `src/gcode/state.ts`: machine state model for G90/G91, units, plane, modal motion, and position.
- `src/gcode/bounds.ts`: machining-footprint and preview segment extraction.
- `src/gcode/transform.ts`: normalization, translation, right-angle rotation, and arc I/J vector transformation.
- `src/gcode/validator.ts`: sheet bounds, collisions, finite coordinate, and transform safety checks.
- `src/gcode/exporter.ts`: combined program generation with comments and safe Z transitions.
- `src/gcode/preparationBounds.ts`: machining extents for reach checks and screw clearance, including drilling and arc extremes.
- `src/gcode/screwPositions.ts`: sparse screw-mark planning outside complete part bounds.
- `src/nesting/nestingEngine.ts`: MVP rectangle/shelf nesting abstraction.
- `src/models`: typed part, instance, sheet, project, and geometry models.
- `src/ui`: React panels and SVG sheet editor.

## Safety Notes

- G90 absolute positioning is the supported MVP export mode.
- G91 incremental positioning is parsed but blocks export.
- G18/G19 non-XY arc planes block export.
- Z depths, feeds, spindle speeds, and machining order inside each part are preserved.
- Rotation transforms X/Y endpoints and I/J arc center vectors together.
- Lines with omitted modal X or Y are reconstructed to include both axes when rotation requires it.
- Export is blocked when parts overlap or leave the sheet.
- Always inspect the preview and air-cut or simulate exported programs before running a CNC machine.

## Sheet Preparation

Each physical sheet starts with a spindle-off move at safe Z to the maximum machining X/Y of its placed components. This exercises the required travel; it does not detect the controller's configured travel limits or verify machine homing.

**Override safe Z** defaults to on at **20 mm** above the material surface. New sheets and older sheets without a saved override use this default; saved heights and an explicitly unticked choice are retained. Set **Safe Z (mm)** to choose a different height. This applies to preparation, screw-mark retracts, inter-component moves, finishing, and above-surface rapid clearance in imported components. The exporter lifts vertically before above-surface lateral rapids. Source cutting depths, feeds, below-surface tab moves, and vertical approach moves such as Z0.5 are preserved. With the override unticked, source clearance is unchanged. The value must be finite and positive (at least 0.5 mm with screw marking). Verify clearance above clamps and available machine Z travel; the app cannot measure either.

New sheets default to **30 mm part spacing**, a **10 mm border**, and **Screw marks** enabled. Untick **Screw marks** on the sheet toolbar to disable marking. Existing sheets retain their saved settings; older sheets without a saved marking choice use the enabled default. The planner assumes a 6 mm cutter and recessed screw heads. It selects up to eight waste-area positions, at least 10 mm from each complete machining bounding box and 10 mm from the sheet edges. Positions never extend beyond the components' maximum X/Y travel. Part interiors and pockets are excluded. If no position fits, export is blocked until the layout is changed or marking is switched off.

Marks plunge to Z-2 at F300 (5 mm/s), with Z0 at the material surface. Each mark is followed by a separate safe-Z retract before XY travel. The program then stops the spindle, parks at X0 Y0, and pauses with M00. After the recessed screws are fitted, START resumes the spindle and original component machining. This runs independently for each physical sheet in combined and separate-file exports. The [DDCS 4.1 manual](https://www.hlt-cnc.com/uploads/38006/files/DDCS-V4.1-English-manual.pdf) documents M0 as program pause and M5 as spindle stop.

The sheet preview shows the same planned mark positions as the exporter. Clearance checks identify waste areas; they do not establish how many screws are needed to secure a particular material or job.

## Known Limitations

- DXF files are associated but not yet parsed into polygon outlines.
- Auto nesting uses rectangular bounds, not true polygon nesting.
- Arc preview is currently line-based in SVG; export still preserves transformed arc commands.
- Start/end section detection is conservative; exported jobs use the saved machine start/end blocks and safe Z.
- Automatic sheet preparation requires G21/G90 programs and explicit X/Y with I/J arc geometry; radius-only and implicit-endpoint arcs block export.
- Unsupported G-code constructs are surfaced as warnings or errors rather than guessed.
# Programmatic Jobs API

The account-scoped jobs API accepts item quantities, auto-nests their components, and queues an immutable job for operator review. It generates a sheet-plan/cutting-list PDF, custom-size labels (50 x 25 mm by default), a JSON manifest, and per-sheet G-code. Manage account API keys and review jobs in **Queue**.

See [API reference and deployment instructions](docs/API.md) for authentication, request examples, retry rules, limits, files, and queue transitions.

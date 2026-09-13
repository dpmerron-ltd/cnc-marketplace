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

The app can run entirely from browser storage, but it also supports Supabase cloud sync for the marketplace library.

1. Open Supabase SQL Editor.
2. Run `supabase/schema.sql`.
3. Restart the app.

For local development, copy `.env.example` to `.env.local` and set:

```bash
VITE_SUPABASE_URL=https://bsnndtwbvgrthddmbhoa.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

The current MVP stores G-code and optional DXF text in Postgres rows. For larger public libraries, move raw files into Supabase Storage and keep only file paths in `cnc_components`.

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
- Editable global start G-code, end G-code, and safe Z.
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

## Known Limitations

- DXF files are associated but not yet parsed into polygon outlines.
- Auto nesting uses rectangular bounds, not true polygon nesting.
- Arc preview is currently line-based in SVG; export still preserves transformed arc commands.
- Start/end section detection is conservative; configure global start/end G-code in the UI before exporting real jobs.
- Unsupported G-code constructs are surfaced as warnings or errors rather than guessed.

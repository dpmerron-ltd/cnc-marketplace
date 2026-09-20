# DXF G-code Generator

## Material Variants

Each generation now produces 6 mm, 12 mm (one pass), 12 mm (two passes), 15 mm and 18 mm programs from the same DXF and operation choices. The Generate thickness control selects the preview and standalone NC download. Saving adds one logical catalogue component with all material variants, not five duplicate components.

On Sheet, **Thickness** selects the program for every placed component across the physical sheets in that project. Preview, nesting, collision checks, combined/per-sheet exports and tab-map PDFs use the selected variant. Changing thickness clears the previous preview and pending export review; placements and source components are retained. Review the new layout and machining before export.

Variants retain their own material depths/passes, blind-drill depths, ramps and tabs. Unsupported combinations are recorded as unavailable, never replaced by another thickness or stripped of geometry. For example, hinge pockets remain available only for 15/18 mm stock. Selecting an unavailable variant blocks export.

**Original NC** preserves the existing workflow for old components without variants. Selecting a thickness requires a variant for every placed component; old NC-only components must be regenerated from DXF first. Existing files, queued jobs and saved sheet settings are not retroactively rewritten. Variants are stored in the owned component's separate `material_variants` field and included in project exports/backups. Apply the additive schema update before publishing this version.

Open **Generate** while signed in. Upload an ASCII DXF, select 6 mm, 12 mm, 15 mm or 18 mm stock, review operations and the toolpath preview, then download a component program or add it to an item in your own account. The drawing stays in the browser until you explicitly add the generated component to an item. Switching accounts unmounts the generator and clears its draft.

You can select multiple DXFs together. Files are reviewed in selection order; **Confirm & add component** adds the current component to the selected catalogue item and opens the next. Downloading NC is a separate action and does not advance the queue. Each drawing requires its own review. Material thickness and the selected catalogue item carry forward, while units, operation overrides and preview state reset. **Add DXFs** appends to an unfinished queue; **Skip file** moves past a file without adding its component. The queue shows confirmed/skipped counts and remains browser-only; leaving Generate or switching accounts clears unprocessed uploads. Each file retains the same individual size and geometry limits.

Programmatic conversion is available through authenticated `POST /v1/dxf-to-nc`, using the same generator and presets. See the [DXF API request and response contract](API.md#generate-nc-from-dxf). API conversion is stateless and does not save components or create queued jobs.

After placing components on a sheet, **Export Combined > Tab map PDF** downloads printable sheet overviews and enlarged tab-location diagrams for removal after cutting. See [tab maps and detection limits](TAB_MAP.md).

## Machining Preset

Select **6 mm (1 pass)** to cut profiles and inside openings to **6.2 mm in one pass**. The API equivalent is `thicknessMm: 6` (omit `profilePasses`). This retains the account's spindle program, F3000 cutting, F600 ramps/drilling, 3-degree ramps, Z20 clearance and existing tab rules. Blind drilling retains the thin-stock 4.5 mm preset with 2, 4, 4.5 mm pecks. Hinge pockets are not allowed in 6 mm stock; other blind pockets must be shallower than 6 mm. Existing tab height remains 6 mm above final depth, leaving 5.8 mm of material at tabs in 6 mm stock. Existing generated files and other thickness presets are unchanged.

**Cutter-width rectangular holes:** closed rectangular/square inside cuts whose narrowest side is at most the configured 6.35 mm cutter automatically have zero tabs, regardless of length or rotation. Undersized holes are widened about their centre to fit the cutter (both dimensions for a square smaller than the cutter), with a review notice. Longer slots use a centreline toolpath and ramps up to 3 degrees; point-sized holes use 2 mm pecks with Z0.5 retracts. Both cut through to the selected material's final depth, not the blind drilling depth. Existing material pass boundaries, Z20 clearance and optional dogbone corner relief are preserved. Widening or corner relief that intersects other geometry or breaks through an enclosing outline blocks export. Positive tab overrides are automatically ignored for these holes.

Select **12 mm (2 passes)** for two 6.1 mm contour passes. This option carries forward through a DXF batch and adds `-2pass` to the generated filename. Drilling remains 4.5 mm deep, with the same pecks, Z20 clearance, ramps and tabs. Explicit blind pockets deeper than 6.1 mm use an initial 6.1 mm pass followed by their assigned depth. The original **12 mm (1 pass)** option remains available. The API equivalent is `thicknessMm: 12, profilePasses: 2`.

| Setting | 18 mm stock | 15 mm stock | 12 mm stock |
| --- | --- | --- | --- |
| Through-cut depth | 18.4 mm | 15.4 mm | 12.2 mm |
| Depth passes | 9.2 mm, then 18.4 mm | 7.7 mm, then 15.4 mm | Default: one pass at 12.2 mm; optional: 6.1 mm, then 12.2 mm |
| Blind drilling depth | 9.2 mm | 9.2 mm | 4.5 mm |
| Drilling pecks | 2, 4, 6, 8, 9.2 mm | 2, 4, 6, 8, 9.2 mm | 2, 4, 4.5 mm |
| Hinge pocket depth | 12 mm | 12 mm | Not allowed |
| Cutter diameter | 6.35 mm | 6.35 mm | 6.35 mm |
| Spindle | Account profile | Account profile | Account profile |
| Clearance above material | 20 mm | 20 mm | 20 mm |
| Contour feed | 3,000 mm/min | 3,000 mm/min | 3,000 mm/min |
| Ramp / drilling feed | 600 mm/min | 600 mm/min | 600 mm/min |
| Ramp angle | 3 degrees | 3 degrees | 3 degrees |

The feed and ramp preset is based on the existing Estlcam-style examples. Their 9.2 mm descent over an out-and-back 87.7733 mm path gives a 3-degree ramp. Tab sections span 16.35 mm of cutter-centre travel, leaving a nominal 10 mm tab after accounting for the cutter. Their tab height is 6 mm above the final cut depth, leaving approximately 5.6 mm of material in 18 mm stock or 5.8 mm in 12 mm stock. This is a new program generated from DXF geometry, not a byte-for-byte reproduction of the original CAM postprocessor.

Profiles offset outside the drawing by 3.175 mm. Door/internal contours offset inside by 3.175 mm. Internal openings whose narrowest full-outline width is at most 12 mm never have tabs, even with a positive override or a door label. Width is measured in millimetres before compensation, independent of rotation; circles use their diameter. Other inside openings default to four tabs. If none fit an ordinary internal cutout, tabs are automatically removed with a waste-movement review warning. Non-door inside cuts also accept an explicit zero-tab override. Larger doors and outside profiles retain mandatory holding tabs and block export when none fit. Outside profiles use their existing 12 mm X/Y threshold. Blind pockets and drills have no tabs. Tabs are kept clear of every entry and re-entry ramp. When a clear span is short, the same 3-degree descent uses additional out-and-back cycles. Below-surface tab lifts use feed moves, not rapids.

The generator uses blue solid outside profiles, gold dashed inside cuts, purple drill targets and charcoal dotted pocket paths. Tabs have yellow centres with dark outlines. The sidebar and legend repeat the same patterns/symbols, and errors use icons and text instead of red/green states. This is the default for every account; no colour-vision setting is required. Appearance changes do not alter G-code.

Drill operations are cutter-sized plunges at the selected material's fixed blind depth. Drill circles define hole centres only: their nominal DXF diameter is ignored and each hole uses the configured 6.35 mm cutter diameter without a diameter warning or approval. Drill-layer depth hints do not override the material drilling preset.

Hinge detection uses geometry: a 35 mm circle (0.02 mm diameter tolerance) fully contained by a non-circular inside/door contour is a hinge pocket. The enclosing contour is treated as a door with holding tabs, including drawings on layer `0`. Hinge pockets default to 12 mm blind depth in 15 mm or 18 mm stock and are blocked in 12 mm stock, even if their depth is overridden. Pockets use a maximum initial pass of 7.7 mm in 15 mm stock or 9.2 mm in 18 mm stock, followed by their assigned final depth. Other internal openings default to through-cuts with tabs determined by the 12 mm size rule, including non-hinge geometry on `POCKET`/`HINGE` layers. Layer depth hints alone do not decide which geometry is a hinge.

Any closed geometry can still be explicitly assigned to Blind pocket in the UI or with `kind: "pocket"` in the API. Blind pockets require a specified depth greater than zero and less than stock thickness; layer `DEPTH` hints remain available for explicit pocket assignments. Depth alone never converts a pocket into a through-hole. Circles use a helical entry and concentric clearing. Closed non-circular contours, including concave polylines and joined line/arc boundaries, use successive cutter-compensated offsets at 40% cutter-diameter stepover. Every split region is retained, each loop has a ramp of at most 3 degrees and a complete floor pass, and travel between loops retracts to Z20. Pockets have no tabs. Nested island boundaries are blocked rather than silently removed; inaccessible narrow recesses remain limited by cutter size.

Automatic dogbone corner overcuts default on for non-circular pockets and inside cuts. These extend beyond sharp internal corners so a square mating part can fit; smooth sampled curves and outer profiles are unchanged. They appear in the actual toolpath preview and review notices. The per-operation Corner overcuts checkbox disables them; API overrides use `cornerOvercuts: false`. Relief that cannot fit, intersects another feature, or breaks through a surrounding contour blocks export. Review allowances and mating geometry before machining.

## Import and Review

**Profile > CNC Program Settings** stores private start, spindle-start and end programs for each account. Configuration is required before generation. Dan's existing settings are retained for his account; other accounts must configure their own programs. The settings apply to new DXF programs and sheet exports, including API generation. Existing saved NC and queued job artifacts are not rewritten. The spindle display reflects the saved profile. Metric absolute-mode and safe-Z guards remain enforced; unsupported mode changes, machining commands and early program termination are blocked. See [account program settings](API.md#account-program-settings) for supported commands.

Supported model-space geometry: XY LINE, ARC, CIRCLE, POINT, LWPOLYLINE (including bulges), and ordinary 2D POLYLINE. Same-layer line/arc chains are joined within 0.01 mm. Curves are sampled with a 0.02 mm chord tolerance for polygon compensation. Millimetres and inches are supported; unspecified units require checking the units selector and displayed dimensions. Text and dimension annotations are excluded with notices.

Layer names suggest drill, inside/door, or outside/profile operations. Otherwise, containment suggests inside versus outside. The 35 mm hinge rule is applied after this classification. These are suggestions, not knowledge of design intent: every operation can be reassigned, including an explicit exclusion. Open contours remain unassigned. Unsupported geometry (including blocks, splines, ellipses, hatches, meshes, and non-XY geometry) blocks export rather than disappearing silently. Export those shapes as flat lines/arcs/polylines first.

Drilling uses explicit G00/G01 moves, not a controller-specific canned cycle. Each peck cuts at most 2 mm of new depth at F600 and retracts to Z0.5 between pecks at the same hole. The final peck stops at the exact blind depth, then retracts to Z20 before travel to another hole or operation. There is no bottom dwell. Sheet safe-Z overrides preserve these Z0.5 retracts only when immediately followed by a deeper vertical feed at the same position; lateral rapid travel still uses the sheet safe Z. This applies to newly generated DXF drilling; existing saved G-code is not rewritten to shorten its pecks.

Geometry is translated into positive coordinates with at least 10 mm clearance at the lower-left machining extent. The drawing translation and maximum X/Y tool-centre extents appear in the page. The component program enforces G21, G17, G90, G94 and Z20, applies the account's start/spindle programs, emits cutting operations, then retracts/stops and applies the end program. It contains no automatic reach-check moves. Reach checks happen only in the sheet exporter, using the placed parts' machining bounds. Drilling and internal work run before outer profiles. The preview is generated by the existing G-code simulator from the actual emitted moves, including configured parking, with operation colours, tab overlays, zoom, pan, and playback.

The export review must be repeated after any machining or geometry change. Check physical stock, tool suitability, dimensions, workholding, tabs, work origin, machine travel, and the DDCS spindle startup delay. Simulation cannot certify a machine setup. No command is sent to the CNC from this page.

One DXF is saved as one component program plus its source DXF. Components can then be added to sheets using the existing library/nesting workflow. Sheet-level screw marking remains a separate sheet-export operation; it is not embedded in every generated component.

Limits: 2 MB ASCII DXF; 1,000 input entities; 250 operations; 25,000 curve points; 50,000 generated lines; machining coordinates at most 10,000 mm. Pocket clearing is also bounded to 25,000 offset vertices and 2,000 offset levels. Invalid, duplicate/intersecting outlines, collapsed offsets, split profile offsets, oversized input, and unsupported operations block export. Split pocket offsets are supported. The generator runs in a cancellable web worker.

## Geometry Libraries

DXF parsing uses [dxf-parser](https://github.com/gdsestimating/dxf-parser) (MIT). Tool-radius compensation and polygon intersections use [Clipper](https://github.com/junmer/clipper-lib) (Boost Software License). The existing G-code parser and simulator are reused for preview and validation.

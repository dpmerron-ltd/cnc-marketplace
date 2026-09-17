# Item Packing Estimates

Every catalogue item with components receives a stacked flat-pack estimate. It includes one copy of each component in that item, not quantities on the current machining sheet. Each layer holds exactly one component, with at most **five components per box**. Larger kits spill into two or more boxes; no components are omitted to meet a two-box limit. Packing never edits G-code or sheet placements.

## Dimensions and Allowances

- The largest outside carton dimension is capped at **1,200 mm**. All three outside dimensions are checked, so a tall stack cannot evade the cap.
- Default padding is **10 mm on all six sides** of each packed stack. Separation is **2 mm between stacked components**. Parts are never placed side-by-side.
- Carton wall thickness defaults to **5 mm per wall**. Outside dimensions add twice this value to internal dimensions. Change it to match the proposed carton construction; real folded cartons can have additional dimensional tolerances.
- Suggested internal dimensions round upwards to 10 mm increments. The suggested size range runs from that size to 20 mm larger per axis, clipped to preserve the outside cap. The displayed arrangement fits any box within that component-wise range. These are suggested dimensions, not verified supplier stock sizes.

Component length/width initially use the imported machining toolpath footprint. This is an estimate, not a guarantee of finished part dimensions. Cutter compensation, retained tabs and a program containing multiple detached parts may need physical measurement. Each component is treated as one solid rectangular footprint; the search does not nest pieces into cutouts or automatically split a multi-part program. Correct its packing measurements or split it into physical components as appropriate.

Thickness comes from the generator's explicit `Material ... mm` header or a `..._18mm...`-style filename hint. It is **not** inferred from drilling depth or deepest cut: those can be blind holes or include spoilboard overcut. When no hint is available, **18 mm is assumed and visibly flagged**. All measurements can be overridden per component for packing only. Invalid dimensions or oversize parts block a suggestion instead of silently dropping those components.

## Arrangement Search

Each stack aligns components' long edges with the box length, rotating 90 degrees where needed. The footprint is the largest length and largest width in that stack. Height is the sum of component thicknesses plus separators and top/bottom padding. All dimensions are then rounded up as described above. Larger-area components are placed at the bottom and smaller components centred above them.

Grouping first minimises the number of boxes, then their combined rounded outside volume. Kits of up to 12 components use exhaustive, memoised grouping under the five-part and dimension limits. Larger kits compare greedy groupings sorted by area, long edge, short edge and thickness; these are **not proof of a global minimum**. The estimator does not consider diagonal packing, bending, assembled goods, interlocking cutouts or arbitrary 3D rotations.

The item grid shows all required box sizes. Item details list each box, its component count and its own size range. Select a box to see the bottom-to-top stack list and numbered layer diagram. The measurements table uses the same component numbers across boxes. Support any overhanging edges with protective inserts during the trial pack.

Loose hardware, carton strength, product weight, compression and courier limits other than the 1,200 mm cap are not modelled. Trial-pack the complete kit before purchasing cartons in quantity. The calculation runs in a cancellable browser worker and supports up to 60 components per item.

## Storage

Per-item allowances and component dimension overrides are saved in `marketplace_items.packing` (JSONB) under existing owner-only RLS, and in the private account browser backup. Derived layouts are recalculated from current components and settings, never stored as permanent approval. Existing items receive an empty settings object and use the stated defaults; no components are modified or removed by the schema addition. Account-to-account project imports remap component IDs inside packing overrides to the new copied components.

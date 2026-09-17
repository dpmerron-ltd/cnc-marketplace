# Item Packing Estimates

Every catalogue item with components receives a flat-pack box estimate. It includes one copy of each component in that item, not quantities on the current machining sheet. Packing never edits G-code or sheet placements.

## Dimensions and Allowances

- The largest outside carton dimension is capped at **1,200 mm**. All three outside dimensions are checked, so a tall stack cannot evade the cap.
- Default padding is **10 mm on all six sides** of the packed stack. Separation is **2 mm between neighbouring components and between layers**.
- Carton wall thickness defaults to **5 mm per wall**. Outside dimensions add twice this value to internal dimensions. Change it to match the proposed carton construction; real folded cartons can have additional dimensional tolerances.
- Suggested internal dimensions round upwards to 10 mm increments. The suggested size range runs from that size to 20 mm larger per axis, clipped to preserve the outside cap. The displayed arrangement fits any box within that component-wise range. These are suggested dimensions, not verified supplier stock sizes.

Component length/width initially use the imported machining toolpath footprint. This is an estimate, not a guarantee of finished part dimensions. Cutter compensation, retained tabs and a program containing multiple detached parts may need physical measurement. Each component is treated as one solid rectangular footprint; the search does not nest pieces into cutouts or automatically split a multi-part program. Correct its packing measurements or split it into physical components as appropriate.

Thickness comes from the generator's explicit `Material ... mm` header or a `..._18mm...`-style filename hint. It is **not** inferred from drilling depth or deepest cut: those can be blind holes or include spoilboard overcut. When no hint is available, **18 mm is assumed and visibly flagged**. All measurements can be overridden per component for packing only. Invalid dimensions or oversize parts block a suggestion instead of silently dropping those components.

## Arrangement Search

The search uses [maxrects-packer](https://github.com/soimy/maxrects-packer), a MaxRects rectangle-packing library, with 0/90-degree in-plane rotation. Candidate box footprints include individual and paired part dimensions plus a 50 mm grid, bounded to 36 values per axis. Each candidate is tested in descending area, longest-edge and thickness order. Every resulting bin becomes a flat layer; its height is the thickest component in that layer. Unused footprint is cropped before carton rounding.

The recommended arrangement has the lowest outside volume among tested candidates. Optional alternatives offer a lower stack or narrower footprint within 25% of that volume. This is a bounded heuristic, **not proof of a global minimum**; it does not consider diagonal packing, bending, assembled goods, interlocking cutouts or arbitrary 3D rotations.

The numbered layer diagram and its component legend show the actual arrangement. The measurements table uses the same numbers. Layers are stacked from the bottom upwards. Mixed-thickness layers may require levelling dunnage to support the next layer; the height model already reserves the full thickness of the tallest piece in each layer.

Loose hardware, carton strength, product weight, compression and courier limits other than the 1,200 mm cap are not modelled. Trial-pack the complete kit before purchasing cartons in quantity. The calculation runs in a cancellable browser worker and supports up to 60 components per item.

## Storage

Per-item allowances and component dimension overrides are saved in `marketplace_items.packing` (JSONB) under existing owner-only RLS, and in the private account browser backup. Derived layouts are recalculated from current components and settings, never stored as permanent approval. Existing items receive an empty settings object and use the stated defaults; no components are modified or removed by the schema addition. Account-to-account project imports remap component IDs inside packing overrides to the new copied components.

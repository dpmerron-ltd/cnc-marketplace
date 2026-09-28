# DXF Toolpath Routing

New DXF generation chooses a shorter route between operations and closer profile
entry points. This is shared by the browser generator, API and material variants.

## Preserved Rules

- Drill, pocket, inside cut, then outside profile.
- Nested inside contours are cut before their enclosing inside contour.
- Profile winding, cutter compensation, physical tab positions and corner reliefs
  are unchanged.
- Entry points reserve tab-free ramp room both before and after the start, so the
  final tab can ramp down before the contour closes.
- Feeds, spindle settings, pass depths, 2 mm pecks and Z20 travel are unchanged.
- Pocket clearing loops still retract independently. No new below-surface links.
- Saved component programs, sheet placement order and queued jobs are not rewritten.

The planner compares the existing route, closer entries in the existing order,
and a nearest-entry route. It only adopts a route with less planned XY travel.
It uses actual operation exit points, including the final pocket-clearing loop.
For opaque controller macros, the initial XY position is unknown and zero is
used only as a routing heuristic, not as an added machine move.

## Verification

Compared the previous generator with the new generator using the 12 Universal
Rack 1000 DXFs and P21.dxf, across all nine cutting profiles: 117 successful
comparisons, unchanged depths, contours, winding and physical tab locations.
Total simulated rapid distance decreased from 265,185.85 mm to 175,044.30 mm
(34.0%). The right-side panel at 12 mm decreased by 40.6%. These figures describe
rapid distance for the test fixtures, not guaranteed machine cycle-time savings.

Existing components need explicit regeneration to receive the new routing. New
machining output still requires preview and operator review before cutting.

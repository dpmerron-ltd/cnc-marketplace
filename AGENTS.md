# CNC tooling

Dan confirmed on 2026-11-11 that every CNC operation uses a **6 mm diameter cutter (3 mm radius)**, across all materials and cutting profiles. This is the authoritative tooling specification and supersedes earlier assumptions.

Keep cutter compensation, drilling, pockets, corner relief, previews, generated NC headers, API metadata and documentation consistent with that specification. Derive cutter-dependent values from the shared CAM preset.

Saved NC and exported jobs contain already-compensated toolpaths. Adopting a changed cutter specification requires regeneration from the source geometry and review; changing a label cannot correct existing coordinates.

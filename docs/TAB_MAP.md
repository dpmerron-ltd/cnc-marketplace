# Printable Tab Maps

On the Sheet page, choose **Export Combined**, then **Tab map PDF** in the export review. It downloads an A4 PDF that can be opened and printed without exporting the NC file or changing its machining. The same download is available when reviewing **Export Sheets**.

Each physical sheet has an overview followed by enlarged maps of its placed components. Part numbers match the sheet and adhesive labels. Heavy outlined spans, dots and numbered callouts remain visible in monochrome; the map does not rely on red/green colours. Detail tables give each tab-span centre in sheet X/Y coordinates, its programmed Z level and its operation. Parts are shown in their placed rotation, with X pointing right and Y up. The diagrams are not cutting templates or full-size prints.

The map uses the parts and sheet placements captured when opening export review, not later edits to the sheet. It uses the same translation/rotation function as the NC exporter. Safe-Z overrides do not move the below-surface tab locations. Source G-code is never modified by PDF generation.

## Detection Limits

The DXF generator's explicit tab comments are supported. Existing Estlcam-style `Part machining` and `Hole machining` operations are also supported: final-depth, below-surface vertical lifts followed by level contour travel are marked as **Inferred** and require checking against the actual parts. Rapid or feed Z lifts are both handled, including the final tab before retract. Earlier passes are not counted again. Drilling, blind pockets, entry/re-entry ramps and clearance travel are excluded.

Unclassified NC, ramped/3D tabs without a level raised span, and other CAM conventions are not reliably identified. Missing/uncertain detections are stated on the part page rather than declaring the component tab-free. A map identifies programmed tab lifts, not proof that material remains after other operations. Verify actual workholding and stop the machine and cutter before removing tabs.

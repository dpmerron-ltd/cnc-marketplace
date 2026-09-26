# Shared 3D-print library

Open **3D Prints** (`#prints`) to upload, preview and download STL files.

- Binary and ASCII STL, up to 25 MB and 500,000 triangles.
- Choose Product part or Packaging; optionally link a catalogue product and add print notes.
- STL is unitless. Choose millimetres or inches to label its dimensions. The original file is never rescaled or modified.
- Mesh parsing runs in a cancellable worker. Three.js renders the interactive preview and a PNG thumbnail. No STL files are loaded until a preview or download is requested.
- Metadata is paginated; thumbnails use short-lived signed URLs from a private Supabase Storage bucket.
- All MFA-authenticated users can browse and download published files, regardless of uploader. Only the uploader can remove an entry. Published files cannot be overwritten.
- Removing an entry revokes new shared access before file cleanup. Previously issued thumbnail URLs can remain valid for up to ten minutes. Downloaded copies are not revoked.
- A preview confirms readable geometry, not watertightness, printability or mechanical suitability. Printing remains a slicer/operator decision.

## Deployment

Apply `supabase/printables.sql` after `supabase/schema.sql`. It creates only the printable library table, its private `cnc-printables` bucket and scoped policies. Existing CNC components, jobs, exports and catalogue rows are not replaced. Both GitHub schema workflows include this step.

`supabase/tests/printables-storage-setup.sql` is a minimal Storage stand-in for an **empty disposable PostgreSQL test database only**. Never run that setup file against Supabase. `supabase/tests/printables-isolation.sql` covers shared access, MFA, anonymous denial, unpublished files, immutable binaries, uploader-only removal and cleanup. Unit tests cover parsing limits, corrupt files, account changes, failed uploads, shared downloads and the library UI.

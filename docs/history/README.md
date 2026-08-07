# Historical AIMTP visual artifacts

- **Document authority:** Canonical archive notice
- **Artifact status:** Historical
- **Current architecture:** [`docs/architecture.md`](../architecture.md)
- **Last reviewed:** 2026-08-07

The images in [`whitepaper-images/`](whitepaper-images/) were added with the
initial AIMTP draft. They document earlier AIMTP naming, email-oriented,
blockchain-oriented, and message-routing directions. They are not the current
AIMTP architecture and must not be used as normative protocol, Gateway,
security, identity, or trust diagrams.

They are preserved byte-for-byte as first committed, including their legacy
naming. An archive that has been edited to agree with current terminology is no
longer evidence of what the project used to think, and the unedited originals
are reachable in the repository history regardless, so correcting them in place
would change nothing a reader can rely on. Read the naming here as a dated
artifact, not as current usage.

The current architecture source of truth is
[`docs/architecture.md`](../architecture.md). Current security boundaries are
documented in [`docs/security.md`](../security.md).

## Provenance and rights

The repository history establishes when these files were added, but does not
establish their creator, generator, or chain of title.

All thirteen PNGs contain image data only — `IHDR`, `IDAT` and `IEND` chunks,
with no text, EXIF, XMP, or C2PA (`caBX`) chunk and no trailing bytes. They
therefore carry no embedded authorship, copyright, or generator claim. This is
checkable rather than asserted: parse the chunk types of every file in
`whitepaper-images/` and confirm that nothing outside those three appears.

Because provenance is unresolved, these files remain excluded from the
repository's CC BY 4.0 and ELv2 grants pending a rights review. All rights are
reserved.

Do not regenerate these diagrams in place. A regenerated file is a new work with
its own provenance — image models embed signed C2PA credentials naming the
generating service — and placing one in this directory would contradict every
statement above. New or corrected diagrams belong outside `history/`, dated and
attributed to whatever produced them.

# DJ-IT

DJ-IT helps turn an old, messy music collection into a smaller intentional collection for DJ use. Its language centers on deciding what is worth carrying forward, then using musical relationships to prepare useful playlists.

## Language

**Triage Decision**:
The user's decision about whether a track is worth carrying forward. The valid decisions are `unheard`, `keep`, `maybe`, `reject`, and `problem`.
_Avoid_: Review status, reviewed, flagged

**Curated Collection**:
The durable set of tracks the user still wants to keep available for DJ use. Tracks enter the Curated Collection by receiving a `keep` Triage Decision.
_Avoid_: Current USB, export, playlist

**Import Scan**:
The fast pass that finds tracks in a music collection and captures whatever information is already available without making the user wait for musical analysis.
_Avoid_: Analysis, deep scan

**Musical Analysis**:
The slower pass that estimates DJ-useful musical properties such as BPM and key. Musical Analysis supports discovery and playlist building, but it is not required before the user can make Triage Decisions.
_Avoid_: Import, scan

**Analysis Candidate**:
A track that is eligible for Musical Analysis in the current working set. Tracks longer than twelve minutes are not Analysis Candidates by default because they are too costly to analyze during normal triage.
_Avoid_: Every imported track, full-library batch

**USB Extraction**:
The act of copying tracks the user chose to carry forward onto a clean USB stick or folder. USB Extraction is the primary near-term output; export targets for DJ software or hardware are separate downstream concerns.
_Avoid_: Engine DJ export, sync, direct-to-USB database write

**Extraction Set**:
The group of tracks chosen for a specific USB Extraction. An Extraction Set is usually made from one or more playlists, not from every track in the Curated Collection.
_Avoid_: Export queue, selected files

**Compatibility Playlist**:
A playlist built from tracks that are likely to mix well together, usually starting from a seed track and using BPM and key compatibility to suggest candidates.
_Avoid_: Graph playlist, automatic set, AI playlist

**Provisional Playlist Track**:
A playlist track whose Triage Decision is `maybe`. It can be used while shaping a playlist, but it remains distinct from tracks already committed to the Curated Collection.
_Avoid_: Rejected track, kept track

**Discovery Graph**:
An exploratory view of relationships between tracks. The Discovery Graph helps the user notice clusters and candidates, but it is secondary to the everyday Compatibility Playlist workflow.
_Avoid_: Primary playlist builder, required workflow

**Library Health**:
The recoverable problems that stop the collection being usable: disconnected sources, missing files, incomplete metadata, failed analysis, and duplicates.
_Avoid_: Automatic deletion, destructive cleanup

**Cleanup Batch**:
A previewed set of metadata-only changes applied together and kept as one undoable action. Cleanup Batches never rename, move, or rewrite source files.
_Avoid_: File cleanup, permanent fix

**Live Playlist**:
A Saved View whose rules are evaluated against the full library whenever it is opened. A Live Playlist can be frozen into an ordinary playlist for manual ordering and USB Extraction.
_Avoid_: Static playlist, loaded rows only

**Metadata Match**:
A proposed metadata correction from an external catalogue such as Beatport. A Metadata Match is never applied until the user approves the visible differences.
_Avoid_: Automatic overwrite, trusted match

## Example Dialogue

Dev: "Should this track be marked reviewed?"

Domain expert: "No. Mark its Triage Decision. If I still want it for future DJ use, it is `keep`; if I need another listen, it is `maybe`; if I do not want to carry it forward, it is `reject`; if the file or metadata needs attention, it is `problem`."

Dev: "Does `keep` mean this track goes onto the next USB?"

Domain expert: "No. `keep` means the track belongs in the Curated Collection. Playlists are created from the Curated Collection, and playlists can then be exported."

Dev: "Should importing a folder analyze every file before the user starts?"

Domain expert: "No. The Import Scan should make tracks available quickly. Musical Analysis can run later for tracks where BPM and key will help triage or playlist building."

Dev: "Should long tracks be analyzed automatically?"

Domain expert: "No. Tracks longer than twelve minutes are excluded from normal Musical Analysis unless the user explicitly opts in."

Dev: "Should a thirteen-minute track be kept off the USB?"

Domain expert: "Not because of length alone. Length affects normal Musical Analysis and automatic compatibility suggestions, not the user's Triage Decision or USB Extraction."

Dev: "Is getting tracks onto a USB the same thing as Engine DJ export?"

Domain expert: "No. USB Extraction means copying the kept collection to a clean destination first. Engine DJ and other export targets can be added later."

Dev: "Should a kept track without BPM or key be copied to USB?"

Domain expert: "Only if it belongs to the playlist or Extraction Set being exported. Missing Musical Analysis can limit playlist suggestions, but it should not block USB Extraction."

Dev: "Should playlist creation require using the graph?"

Domain expert: "No. A Compatibility Playlist should be easy to build from a seed track and candidate list. The Discovery Graph remains available for exploration when a visual overview helps."

Dev: "Can a playlist contain a track I have not fully decided to keep?"

Domain expert: "Yes. A `maybe` track can be a Provisional Playlist Track, but it should remain visibly different from tracks in the Curated Collection."

Dev: "Can provisional tracks be exported?"

Domain expert: "Yes, but exporting a playlist with Provisional Playlist Tracks should require an explicit include, exclude, or promote-to-keep decision."

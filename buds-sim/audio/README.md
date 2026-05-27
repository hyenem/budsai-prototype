# buds-sim audio

The simulator's "system playback" track ships with two **synthetic** sources
that work without any mp3 files:

- `synthetic-melody` — WebAudio oscillator looping an A-major arpeggio
- `synthetic-podcast` — speech-like rising/falling cadence

If you'd like real audio clips for richer demos, drop mp3 files into this
folder with these names (gitignored):

- `bts-dynamite-30s.mp3`  — 30 s of any vocal music clip
- `podcast-30s.mp3`       — 30 s of any spoken-word clip

The select dropdown in the UI already references these paths.

# Audio metadata-strip verification harness

Shared evidence for the inline-audio work: the desktop client strips audio
metadata before upload, and the relay validates the stripped shape. Both
sides must agree on exact bytes, so both sides test against these fixtures.

Unlike the `ios/` and `android/` fixtures, the files here are **generated,
not committed** — they come from `ffmpeg` deterministically, and one of them
is 127 KB of synthetic album art that has no business in git history.

## Generating

```sh
./make_fixtures.sh [output-dir]   # defaults to ./fixtures
```

Requires `ffmpeg`/`ffprobe` on PATH. Every fixture embeds a known location
marker (`GPS 37.7749N 122.4194W`), so a stripper that does nothing cannot
pass — see the negative control in `check_strip.sh`.

## The fixtures that carry weight

| Fixture | Why it exists |
|---|---|
| `tagged.{mp3,ogg,wav}` | Baseline: title + location comment in each container. |
| `mpeg2_22k.mp3` | 22.05 kHz MPEG-2 mp3. Frame sync is `FF F3`. |
| `mpeg25_11k.mp3` | 11.025 kHz MPEG-2.5 mp3. Frame sync is `FF E3`. |
| `bigart.ogg` | 120 KB comment value, so the Vorbis comment packet **spans pages**. |
| `long.ogg` | 30 s, multiple audio pages after setup. |

`infer::is_mp3` (infer 0.19.0, `src/matchers/audio.rs`) matches only ID3
magic or the MPEG-1 sync `FF FB`. The two MPEG-2/2.5 fixtures are therefore
recognised *solely* by their ID3 header: strip it and `infer::get()` returns
`None`. Any acceptance path that consults `infer` for mp3 will silently
downgrade these files to generic attachments, so both the client sniff and
the relay validator must key on MPEG frame structure instead.

`bigart.ogg` is the Ogg correctness case. Its comment packet exhausts one
page's 255 lacing values and continues onto the next (continuation bit set in
the following page header), so the comment cannot be excised in place — the
header region must be demuxed into packets and re-paginated, with
`page_sequence_number` renumbered and every page CRC recomputed
(RFC 3533 §6, polynomial `0x04c11db7`).

## Checking a stripper

```sh
./check_strip.sh <original> <stripped> [marker-regex]
```

Four independent instruments, all of which must pass:

1. **Marker grep**, with a negative control on the original — did it strip?
   (If the marker is absent from the original the check reports itself blind
   rather than passing.)
2. **`ffmpeg -f null -`** — does it still decode?
3. **`ffprobe` duration** — did it truncate?
4. **PCM SHA compare** — decode both files to raw `s16le` and compare. This
   is the only instrument that proves the strip is *lossless*.

Instruments 2 and 3 both pass on a file that still contains the metadata you
believe you removed; that failure was observed during development, on an Ogg
rewrite that dropped continuation pages while leaving 58 KB of payload behind
and still reporting the correct duration. Do not rely on decodability alone.

## Checking Ogg page structure

```sh
python3 verify_contract.py <file.ogg>...
```

Asserts the canonical layout the client emits: one logical stream, page
sequence contiguous from 0, every page CRC recomputed and re-verified, the
identification packet alone on the BOS page, the canonical empty comment
packet alone on page 1 with a single lacing value, and the setup packet
isolated on its own page(s). Written from RFC 3533 rather than from any
particular stripper implementation, so it is an independent oracle.

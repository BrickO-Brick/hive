#!/usr/bin/env bash
# Four independent instruments. A strip is correct only if ALL four pass.
# Usage: check_strip.sh <original> <stripped> [marker]
set -uo pipefail
ORIG="$1"; STRIP="$2"; MARK="${3:-GPS\|TITLE\|Lavf\|XXXXXXXX}"
fail=0

# (1) metadata actually gone. Run against the ORIGINAL first as a negative
#     control -- if the marker isn't in the original, this instrument is blind.
oh=$(strings -a "$ORIG"  | grep -ci "$MARK" || true)
sh=$(strings -a "$STRIP" | grep -ci "$MARK" || true)
if [ "$oh" -eq 0 ]; then echo "  [!] BLIND: marker absent from original, test proves nothing"; fail=1
elif [ "$sh" -ne 0 ]; then echo "  [x] metadata STILL PRESENT ($sh hits)"; fail=1
else echo "  [ok] metadata gone (original had $oh hits)"; fi

# (2) still decodes
if ffmpeg -loglevel error -i "$STRIP" -f null - 2>/dev/null; then echo "  [ok] decodes"
else echo "  [x] DECODE FAILED"; fail=1; fi

# (3) duration preserved
d1=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$ORIG")
d2=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$STRIP")
if [ "$d1" = "$d2" ]; then echo "  [ok] duration $d2"; else echo "  [x] duration $d1 -> $d2"; fail=1; fi

# (4) THE ONE THAT MATTERS: audio bit-exact. Decode both to raw PCM, compare.
#     (2) and (3) both pass on a file that still contains the metadata.
a=$(ffmpeg -loglevel error -i "$ORIG"  -f s16le - 2>/dev/null | shasum | cut -d' ' -f1)
b=$(ffmpeg -loglevel error -i "$STRIP" -f s16le - 2>/dev/null | shasum | cut -d' ' -f1)
if [ "$a" = "$b" ]; then echo "  [ok] PCM bit-identical"; else echo "  [x] PCM DIFFERS -- strip is lossy"; fail=1; fi

echo "  => $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

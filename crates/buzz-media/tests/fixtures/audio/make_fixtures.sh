#!/usr/bin/env bash
# Fixture generator for the audio metadata-strip work (block/buzz audio inline).
# Every fixture carries a known location marker so a no-op "stripper" cannot pass.
set -euo pipefail
OUT="${1:-fixtures}"
mkdir -p "$OUT"; cd "$OUT"
MARK="GPS 37.7749N 122.4194W"
SINE="sine=frequency=440:duration=2"

# 1. baseline tagged files, one per container
ffmpeg -loglevel error -f lavfi -i "$SINE" -metadata title="TITLE" -metadata comment="$MARK" -y tagged.mp3
ffmpeg -loglevel error -f lavfi -i "$SINE" -metadata title="TITLE" -metadata comment="$MARK" -y tagged.ogg
ffmpeg -loglevel error -f lavfi -i "$SINE" -metadata title="TITLE" -metadata comment="$MARK" -y tagged.wav

# 2. THE ONE THAT BREAKS infer: MPEG-2 (22.05kHz) -> 0xFF 0xF3 sync, not 0xFF 0xFB.
#    Strip its ID3 and infer::get() returns None.
ffmpeg -loglevel error -f lavfi -i "$SINE" -ar 22050 -b:a 32k -metadata title="T" -y mpeg2_22k.mp3
# MPEG-2.5 (11.025kHz) -> 0xFF 0xE3
ffmpeg -loglevel error -f lavfi -i "$SINE" -ar 11025 -b:a 32k -metadata title="T" -y mpeg25_11k.mp3

# 3. album art large enough that the Ogg comment packet SPANS pages
#    (page1 hits 255 lacing values, page2 sets the continuation bit).
BIG=$(python3 -c 'print("X"*120000)')
ffmpeg -loglevel error -f lavfi -i "$SINE" -metadata comment="$BIG" -y bigart.ogg

# 4. longer file: multiple audio pages after setup
ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=30" -y long.ogg

echo "fixtures written to $(pwd)"
ls -la

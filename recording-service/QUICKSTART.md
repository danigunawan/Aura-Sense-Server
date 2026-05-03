# AuraSense Recording Service — Quick Start

Records all active cameras as 5-minute MP4 segments on the external disk.

## Prerequisites

- mediamtx must be running (`systemctl status aurasense-mediamtx`)
- External disk mounted at `/media/aura/recordaura` (224 GB, `/dev/sdb1`)
- Node.js 18+ installed

## One-time setup

```bash
cd recording-service
npm install
```

## Run manually (dev / test)

```bash
# Standard — FFmpeg output suppressed (only segment index lines printed)
node index.js

# Verbose — FFmpeg stderr forwarded to console
LOG_FFMPEG=1 node index.js
```

Expected output per camera every 5 minutes:
```
[entrance] indexed 20260503_143000.mp4 (22.4 MB)
[parking]  indexed 20260503_143000.mp4 (18.1 MB)
[lobby]    indexed 20260503_143000.mp4 (25.7 MB)
```

## Install as systemd service

```bash
sudo bash /home/aura/Documents/aurasense/systemd/install.sh
sudo systemctl start aurasense-recording
sudo systemctl status aurasense-recording
```

## Logs

```bash
journalctl -u aurasense-recording -f
journalctl -u aurasense-recording --since "1 hour ago"
```

## Storage layout

```
/media/aura/recordaura/recordings/
  entrance/
    20260503_143000.mp4     # 5-min segment (wall-clock aligned)
    20260503_143500.mp4
    segments.csv            # FFmpeg segment index (internal)
  parking/
    ...
  lobby/
    ...
```

## Disk budget (estimated)

| Metric | Value |
|---|---|
| Disk cap | 200 GB |
| Eviction trigger | 190 GB |
| Sub-stream bitrate | ~512 kbps per camera |
| Segment size | ~23 MB per camera per 5 min |
| Daily usage (3 cameras) | ~20 GB/day |
| Rolling retention | **~10 days** |

Old segments are deleted oldest-first automatically. No manual cleanup needed.

## How it works

1. Reads `cameras` table from `camera_discovery/cameras.db` every 30 s
2. Spawns one FFmpeg process per active camera pulling from `rtsp://localhost:8554/{name}-sub`
3. FFmpeg writes `%Y%m%d_%H%M%S.mp4` files aligned to 5-min wall-clock boundaries
4. FFmpeg appends completed segments to `segments.csv`; service polls that file every 5 s
5. Each completed segment is inserted into the `clips` table (used by API gateway + dashboard)
6. Storage manager checks disk every 60 s and evicts oldest clips when > 190 GB used

## FFmpeg command (exact, per camera)

```bash
ffmpeg -hide_banner -loglevel warning \
  -rtsp_transport tcp \
  -i rtsp://localhost:8554/entrance-sub \
  -c:v copy -tag:v hvc1 -c:a copy \
  -f segment \
  -segment_time 300 \
  -segment_atclocktime 1 \
  -reset_timestamps 1 \
  -strftime 1 \
  -segment_list /media/aura/recordaura/recordings/entrance/segments.csv \
  -segment_list_type csv \
  -segment_list_flags +append \
  -movflags +faststart \
  /media/aura/recordaura/recordings/entrance/%Y%m%d_%H%M%S.mp4
```

Flags explained:
- `-c copy` — zero CPU, no decode/encode (stream copy)
- `-tag:v hvc1` — lets MP4 containers hold H.265; ignored on H.264
- `-segment_atclocktime 1` — aligns cuts to :00/:05/:10/… boundaries
- `-reset_timestamps 1` — each segment starts at PTS 0 (required for valid MP4)
- `-movflags +faststart` — moov atom at start (enables progressive download)
- `-segment_list_flags +append` — CSV survives FFmpeg restarts without duplicate entries

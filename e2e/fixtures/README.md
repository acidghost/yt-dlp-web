# Local player media

Synthetic 12-second video and tone, generated with ffmpeg (no upstream content).
The MP4 playback test copies `player.mp4` into the test server's
`tmp/e2e-data/media/abcdefghijk/video.mp4` and uses the real `/api/stream` endpoint,
including its byte-range responses. HLS fixtures use same-origin Playwright
routes. No YouTube or other external media is used. `.mpegts` is MPEG-TS, named
differently from TypeScript so segments are not picked up by code checks.

Regenerate from the repository root:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=10' \
  -f lavfi -i 'sine=frequency=440:sample_rate=44100' -t 12 \
  -c:v libx264 -pix_fmt yuv420p -preset veryslow -crf 35 -g 20 \
  -c:a aac -b:a 24k -movflags +faststart -y e2e/fixtures/player.mp4
ffmpeg -i e2e/fixtures/player.mp4 -c copy -hls_time 2 -hls_playlist_type vod \
  -hls_segment_filename 'e2e/fixtures/player-%d.mpegts' \
  -y e2e/fixtures/player.m3u8
```

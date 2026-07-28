# Upload Studio carousel screenshots

Regenerates the four PNGs in `assets/directory-submission/` used for the
Connectors Directory submission (MCP Apps require carousel screenshots).

`harness.html` is the widget HTML from `src/tools/upload_studio.ts` with a stub
`window.openai` injected, so the studio renders with realistic prefilled data
and walks through four states without touching the real API or R2.

    python3 -m http.server 8765     # from this directory
    python3 capture.py

`capture.py` drives Chrome over CDP rather than `--screenshot`: the widget's
`<video>` preview decodes in real time, and `--virtual-time-budget` fast-forwards
timers past the decode, which leaves a loading spinner in the frame.

Scenes: 1 studio opened · 2 video selected · 3 publishing · 4 queued.
Paired prompt text lives in `assets/directory-submission/PROMPTS.md`.

If the widget markup changes, re-extract it:

    node dist/index.js --http &
    # then resources/read ui://upload-post/video-upload-studio.html and
    # re-inject the stub block from the top of harness.html

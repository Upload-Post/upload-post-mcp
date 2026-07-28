# Carousel screenshots — Upload Studio (MCP App)

Four PNGs of the `open_upload_studio` widget, cropped to the app response only
(no prompt in frame), 2112px wide. Anthropic asks for the prompt text that
produced each screenshot, supplied separately — those are below.

| File | Paired prompt |
|---|---|
| `01-studio-opened.png` | "I've got a video on my laptop I want to put on Instagram, TikTok and YouTube. Open the upload studio for my acme-social profile." |
| `02-video-selected.png` | "Use summer-shoot-final.mp4, caption it 'Behind the scenes of our summer shoot' and add a first comment asking which frame should be the next cover." |
| `03-publishing.png` | "Looks good — publish it." |
| `04-queued.png` | "Did it go through? Show me the request id." |

Regenerate with `scripts/shoot-studio-screenshots/` (harness + CDP driver) if the
widget UI changes.

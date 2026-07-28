import json, subprocess, time, urllib.request, base64, sys
from pathlib import Path
from PIL import Image, ImageChops

HERE = Path(__file__).parent
OUT = HERE.parent.parent / "assets" / "directory-submission"
OUT.mkdir(parents=True, exist_ok=True)

def crop(src, dst, pad=48):
    """Trim to the widget's bounding box so the shot contains the app response only."""
    im = Image.open(src).convert("RGB")
    bg = im.getpixel((5, 5))
    box = ImageChops.difference(im, Image.new("RGB", im.size, bg)).getbbox()
    l, t, r, b = box
    im.crop((max(0, l - pad), max(0, t - pad),
             min(im.width, r + pad), min(im.height, b + pad))).save(dst)
    src.unlink()
from websocket import create_connection

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9333
proc = subprocess.Popen([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
    "--autoplay-policy=no-user-gesture-required",
    f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
    "--user-data-dir=/tmp/cdp-profile", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)

def targets():
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))

ws_url = None
for _ in range(20):
    try:
        t = [x for x in targets() if x["type"] == "page"]
        if t: ws_url = t[0]["webSocketDebuggerUrl"]; break
    except Exception: pass
    time.sleep(0.5)
assert ws_url, "no page target"

ws = create_connection(ws_url, suppress_origin=True)
_id = [0]
def cmd(method, params=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == _id[0]:
            if "error" in m: raise RuntimeError(m["error"])
            return m.get("result", {})

cmd("Page.enable"); cmd("Runtime.enable")

scenes = {1:"01-studio-opened", 2:"02-video-selected", 3:"03-publishing", 4:"04-queued"}
for s, name in scenes.items():
    h = 1750
    cmd("Emulation.setDeviceMetricsOverride", {"width":1400,"height":h,"deviceScaleFactor":2,"mobile":False})
    cmd("Page.navigate", {"url": f"http://127.0.0.1:8765/harness.html?scene={s}"})
    # wait for the harness to signal the scene is composed
    ok = False
    for _ in range(120):
        time.sleep(0.5)
        r = cmd("Runtime.evaluate", {"expression":"document.body.dataset.ready === '1'","returnByValue":True})
        if r.get("result",{}).get("value"): ok = True; break
    time.sleep(1.2)   # let the video paint a real frame
    print(f"scene {s}: ready={ok}")
    shot = cmd("Page.captureScreenshot", {"format":"png","captureBeyondViewport":True})
    raw = OUT / f"raw-{s}.png"
    raw.write_bytes(base64.b64decode(shot["data"]))
    crop(raw, OUT / f"{name}.png")

ws.close(); proc.terminate()
print("done")

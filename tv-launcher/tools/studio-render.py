#!/usr/bin/env python3
"""Render the studio for the launcher's Home tile and controller, from the hub's own 3D view.

    python3 -m venv /tmp/sr && /tmp/sr/bin/pip install aiohttp pillow
    /tmp/sr/bin/python tv-launcher/tools/studio-render.py [--hub http://192.168.0.127:8766]

Opens the hub's panel in headless Chrome as the phone layout (1080×1500 at 2.5×), without the
site (no landscape or sky, so the stage is see-through), in the dark look, with the "Cozy" scene
on. Nothing reaches the real lights: the page's events are cut off and every command it sends
gets a made-up "ok". The page itself is then made transparent, and the house is cut out to
app/src/main/res/drawable-nodpi/studio_render.webp, with a check picture beside it (/tmp) that
marks where ui/Studio.kt's StudioRender puts each light. If the marks miss (the plan's camera,
walls or size changed), refit StudioRender's constants from the new picture.

Needs Google Chrome.
"""
import argparse
import asyncio
import base64
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import aiohttp
from PIL import Image, ImageDraw

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT = Path(__file__).resolve().parents[1] / "app/src/main/res/drawable-nodpi/studio_render.webp"
CHECK = Path("/tmp/studio-render-check.png")
VIEW = (1080, 1500, 2.5)
CROP = (780, 140, 1880, 1100)   # the house, in the 2.5× screenshot
PORT = 9334

LOOK = """(async () => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Cozy');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 2500));
  const st = document.createElement('style');
  st.textContent = '*:not(canvas){background:transparent!important;background-image:none!important;box-shadow:none!important;'
    + 'border-color:transparent!important;color:transparent!important} *::before,*::after{display:none!important}'
    + ' svg,img,button{visibility:hidden!important}';
  document.head.appendChild(st);
  await new Promise(r => setTimeout(r, 1500));
  return Boolean(b);
})()"""


async def shoot(hub: str) -> Image.Image:
    profile = tempfile.mkdtemp()
    chrome = subprocess.Popen([
        CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}", "--hide-scrollbars",
        "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks",
        "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        async with aiohttp.ClientSession() as s:
            for _ in range(50):
                try:
                    async with s.get(f"http://127.0.0.1:{PORT}/json") as r:
                        tabs = await r.json()
                        break
                except aiohttp.ClientError:
                    await asyncio.sleep(0.2)
            page = next(t for t in tabs if t["type"] == "page")["webSocketDebuggerUrl"]
            async with s.ws_connect(page, max_msg_size=0) as ws:
                waiting: dict[int, asyncio.Future] = {}
                events: asyncio.Queue = asyncio.Queue()
                n = 0

                async def read():
                    async for msg in ws:
                        m = json.loads(msg.data)
                        if m.get("id") in waiting:
                            waiting.pop(m["id"]).set_result(m.get("result", m))
                        elif "method" in m:
                            await events.put(m)

                async def call(method, **params):
                    nonlocal n
                    n += 1
                    waiting[n] = asyncio.get_running_loop().create_future()
                    await ws.send_json({"id": n, "method": method, "params": params})
                    return await waiting[n]

                async def intercept():
                    while True:
                        ev = await events.get()
                        if ev["method"] != "Fetch.requestPaused":
                            continue
                        p = ev["params"]
                        url, rid = p["request"]["url"], p["requestId"]
                        if "/api/call" in url or "/api/rescan" in url:
                            await call("Fetch.fulfillRequest", requestId=rid, responseCode=200,
                                       responseHeaders=[{"name": "Content-Type", "value": "application/json"}],
                                       body=base64.b64encode(b'{"ok": true}').decode())
                        elif "/api/events" in url:
                            await call("Fetch.failRequest", requestId=rid, errorReason="Failed")
                        elif p.get("responseStatusCode") and url.split("?")[0].rstrip("/") == hub:
                            body = await call("Fetch.getResponseBody", requestId=rid)
                            html = base64.b64decode(body["body"]).decode() if body.get("base64Encoded") else body["body"]
                            m = re.search(r"window.__HOUSE_BOOT__=(\{.*?\})</script>", html)
                            boot = json.loads(m.group(1))
                            boot["config"].pop("site", None)
                            html = html.replace(m.group(1), json.dumps(boot))
                            await call("Fetch.fulfillRequest", requestId=rid, responseCode=200,
                                       responseHeaders=[{"name": "Content-Type", "value": "text/html"}],
                                       body=base64.b64encode(html.encode()).decode())
                        else:
                            await call("Fetch.continueRequest", requestId=rid)

                reader = asyncio.create_task(read())
                fetcher = asyncio.create_task(intercept())
                await call("Fetch.enable", patterns=[
                    {"urlPattern": hub + "/*", "requestStage": "Response"},
                    {"urlPattern": "*api/events*", "requestStage": "Request"},
                    {"urlPattern": "*api/call*", "requestStage": "Request"},
                    {"urlPattern": "*api/rescan*", "requestStage": "Request"},
                ])
                w, h, dpr = VIEW
                await call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=dpr, mobile=False)
                await call("Emulation.setDefaultBackgroundColorOverride", color={"r": 0, "g": 0, "b": 0, "a": 0})
                await call("Page.enable")
                await call("Page.navigate", url=hub + "/?theme=dark&platform=ios")
                await asyncio.sleep(9)
                done = await call("Runtime.evaluate", expression=LOOK, awaitPromise=True, returnByValue=True)
                if not done.get("result", {}).get("value"):
                    sys.exit("The panel had no Cozy scene to light the house with")
                shot = await call("Page.captureScreenshot", format="png")
                fetcher.cancel()
                reader.cancel()
                return Image.open(io.BytesIO(base64.b64decode(shot["data"])))
    finally:
        chrome.terminate()


def check(cut: Image.Image, plan: dict) -> None:
    """Marks each light where StudioRender projects it (the constants in ui/Studio.kt)."""
    rx, rz, ux, uy, uz = 0.927184, -0.374607, -0.295194, 0.615661, -0.730631
    sx, sy, cx, cy = 0.094655, 0.108458, 0.337055, 0.068469
    h = plan.get("wallHeight", 2.5)
    glow = {"table": lambda y: (y or 0.5) + 0.27, "ceiling": lambda y: y or h - 0.14, "spots": lambda y: (y or h - 0.16) - 0.06,
            "pendant": lambda y: y or 1.8, "floor": lambda y: 1.28, "strip": lambda y: y or 1.0}
    out = Image.new("RGBA", cut.size, (30, 52, 46, 255))
    out.alpha_composite(cut)
    d = ImageDraw.Draw(out)
    things = [(l["name"], l["pos"], glow.get(l.get("type"), lambda y: y or 1.0)(l.get("y"))) for l in plan.get("lights", [])]
    things += [(a["name"], a["pos"], a.get("y", 2.15)) for a in plan.get("acs", [])]
    for name, (x, z), y in things:
        u = (cx + sx * (x * rx + z * rz)) * cut.width
        v = (cy - sy * (x * ux + y * uy + z * uz)) * cut.height
        d.ellipse([u - 16, v - 16, u + 16, v + 16], outline=(0, 255, 255), width=4)
        d.text((u + 22, v - 8), name, fill=(0, 255, 255))
    out.convert("RGB").save(CHECK)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub", default="http://192.168.0.127:8766")
    hub = ap.parse_args().hub.rstrip("/")
    shot = asyncio.run(shoot(hub))
    cut = shot.crop(CROP)
    cut.save(OUT, "WEBP", quality=88, method=6)
    import urllib.request
    plan = json.load(urllib.request.urlopen(hub + "/api/plan", timeout=15))
    check(cut, plan)
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB) and {CHECK}: check that the marks sit on the lights.")


if __name__ == "__main__":
    main()

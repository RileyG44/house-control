#!/usr/bin/env python3
"""Connect a Spotify account with PKCE, without a client secret.

Run on the Mac, with http://127.0.0.1:8767/callback registered in your Spotify app:
  .venv/bin/python spotify_pair.py --client-id YOUR_PUBLIC_CLIENT_ID
The Mac hub then supplies Spotify Connect to the Dell through its existing peer route.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import os
import secrets
import time
import webbrowser
from pathlib import Path
from urllib.parse import urlencode

import aiohttp
from aiohttp import web

from spotify import TOKEN, read_config, save_config

REDIRECT = "http://127.0.0.1:8767/callback"
SCOPES = "user-read-playback-state user-modify-playback-state"


async def pair(client_id: str, conf: Path):
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(32)
    code = asyncio.get_running_loop().create_future()

    async def callback(request):
        if not secrets.compare_digest(request.query.get("state", ""), state):
            return web.Response(status=400, text="That sign-in is not this pairing request.")
        if code.done():
            return web.Response(status=409, text="This sign-in has already been used.")
        if request.query.get("error") or not request.query.get("code"):
            code.set_exception(RuntimeError("Spotify sign-in was cancelled."))
            return web.Response(text="Spotify was not connected. You can close this page.")
        code.set_result(request.query["code"])
        return web.Response(text="Spotify sign-in received. You can close this page and return to House Control.")

    app = web.Application()
    app.router.add_get("/callback", callback)
    runner = web.AppRunner(app, access_log=None)  # callback URLs contain short-lived authorization codes
    await runner.setup()
    try:
        await web.TCPSite(runner, "127.0.0.1", 8767).start()
        url = "https://accounts.spotify.com/authorize?" + urlencode({
            "client_id": client_id, "response_type": "code", "redirect_uri": REDIRECT,
            "scope": SCOPES, "code_challenge_method": "S256", "code_challenge": challenge, "state": state})
        print("Opening Spotify sign-in. This request expires in five minutes.")
        webbrowser.open(url)
        auth_code = await asyncio.wait_for(code, 300)
        async with aiohttp.ClientSession() as http:
            async with http.post(TOKEN, data={"client_id": client_id, "grant_type": "authorization_code",
                                              "code": auth_code, "redirect_uri": REDIRECT, "code_verifier": verifier},
                                 timeout=aiohttp.ClientTimeout(total=20)) as response:
                if response.status != 200:
                    raise RuntimeError("Spotify could not complete sign-in. Check the app’s client ID and redirect URI.")
                tokens = await response.json()
        cfg = read_config(conf / "spotify.json")
        cfg.update(client_id=client_id, access_token=tokens["access_token"], refresh_token=tokens["refresh_token"],
                   expires_at=time.time() + tokens.get("expires_in", 3600))
        save_config(conf / "spotify.json", cfg)
        print("Spotify is connected. Open the speaker remote to choose your Echo or another Spotify Connect output.")
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-id", required=True, help="Public client ID from your Spotify developer app")
    parser.add_argument("--conf", type=Path, default=Path(os.environ.get("HOUSE_HUB_DIR", Path.home() / ".house-hub")))
    args = parser.parse_args()
    if len(args.client_id) != 32 or not all(c in "0123456789abcdefABCDEF" for c in args.client_id):
        parser.error("The public Spotify client ID should be 32 hexadecimal characters")
    try:
        asyncio.run(pair(args.client_id, args.conf))
    except (RuntimeError, asyncio.TimeoutError, aiohttp.ClientError) as error:
        raise SystemExit(str(error) or "Spotify sign-in timed out. Run the command again to retry.")

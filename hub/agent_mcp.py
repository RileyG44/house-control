#!/usr/bin/env python3
"""The house tools as an MCP server (docs/voice-agent.md): stdio, newline-delimited JSON-RPC 2.0.

Codex starts it for the house agent (agent.py passes it in `-c mcp_servers.house…`); any other MCP
client on the hub computer can too:

    claude mcp add house -- ~/house-control/hub/.venv/bin/python ~/house-control/hub/agent_mcp.py

It holds no state and needs nothing outside the standard library: the tool list is the running
hub's GET /api/agent/tools, and each call is POST /api/agent/tool/<name>, both answered only on
loopback. HOUSE_HUB_URL says where the hub is (http://127.0.0.1:8766).
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HUB = os.environ.get("HOUSE_HUB_URL", "http://127.0.0.1:8766").rstrip("/")
PROTOCOL = "2025-06-18"   # answered when the client names none; otherwise the client's own
TIMEOUT = 60              # a call that opens an app waits for a sleeping TV
INSTRUCTIONS = ("Riley's home: lights, the air conditioner, the TV and Spotify. Call get_home first; it lists every "
                "device, scene and app by name. Act on what was asked, then say in a short sentence what changed.")
# Straight to the hub: never through a proxy the environment names for the internet.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class HubError(Exception):
    pass


def hub(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(HUB + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data is not None else {})
    try:
        with OPENER.open(req, timeout=TIMEOUT) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            said = json.load(e).get("error")
        except (ValueError, AttributeError):
            said = None
        raise HubError(said or f"The hub answered HTTP {e.code}") from e
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise HubError(f"The hub at {HUB} isn't answering ({getattr(e, 'reason', e)})") from e


def tools() -> list[dict]:
    listed = hub("GET", "/api/agent/tools").get("tools") or []
    # Nothing here deletes anything or reaches past the home.
    return [{**t, "annotations": {**(t.get("annotations") or {}), "destructiveHint": False, "openWorldHint": False}}
            for t in listed if isinstance(t, dict) and t.get("name")]


def call(name, arguments) -> dict:
    if not isinstance(name, str) or not name:
        return {"content": [{"type": "text", "text": "Say which tool"}], "isError": True}
    try:
        got = hub("POST", "/api/agent/tool/" + urllib.parse.quote(name, safe=""), arguments if isinstance(arguments, dict) else {})
    except HubError as e:
        return {"content": [{"type": "text", "text": str(e)}], "isError": True}
    out = {"content": got.get("content") or [{"type": "text", "text": "Done"}], "isError": bool(got.get("isError"))}
    if isinstance(got.get("structuredContent"), dict):
        out["structuredContent"] = got["structuredContent"]
    return out


def handle(msg) -> dict | None:
    """The answer to one message; None for a notification (or a client's own answer)."""
    if not isinstance(msg, dict) or "method" not in msg:
        return None if isinstance(msg, dict) else error(None, -32600, "Not a JSON-RPC message")
    if "id" not in msg:
        return None  # notifications/initialized, cancelled …
    rid, method, params = msg["id"], msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion") if isinstance(params, dict) else None
        return result(rid, {"protocolVersion": asked if isinstance(asked, str) and asked else PROTOCOL,
                            "capabilities": {"tools": {"listChanged": False}},
                            "serverInfo": {"name": "house", "title": "House Control", "version": "1.0.0"},
                            "instructions": INSTRUCTIONS})
    if method == "ping":
        return result(rid, {})
    if method == "tools/list":
        try:
            return result(rid, {"tools": tools()})
        except HubError as e:
            return error(rid, -32603, str(e))
    if method == "tools/call":
        return result(rid, call(params.get("name"), params.get("arguments")))
    return error(rid, -32601, f"No method {method}")


def result(rid, value: dict) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "result": value}


def error(rid, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            answer = error(None, -32700, "Not JSON")
        else:
            answer = handle(msg)
        if answer is not None:
            sys.stdout.write(json.dumps(answer) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()

"""Pretend WiZ lights for testing without hardware: `python tests/fake_wiz.py`.

Each one answers getPilot / setPilot / getSystemConfig on its own loopback address
(127.0.0.2, 127.0.0.3, …), the way real lights do on the Wi-Fi.
"""
from __future__ import annotations

import asyncio
import json
import socket
import sys

LIGHTS = [
    {"ip": "127.0.0.2", "mac": "d8a0113a23e6", "module": "ESP56_SHTW3_01",
     "pilot": {"state": True, "dimming": 60, "temp": 2700}},
    {"ip": "127.0.0.3", "mac": "444f8ec6fad8", "module": "ESP03_SHRGB3_01ABI",
     "pilot": {"state": False, "dimming": 100, "r": 255, "g": 80, "b": 0}},
    {"ip": "127.0.0.4", "mac": "444f8e0068c8", "module": "ESP01_SHRGB1C_31",
     "pilot": {"state": True, "dimming": 30, "temp": 4000}},
]


class Bulb(asyncio.DatagramProtocol):
    def __init__(self, light):
        self.light = light
        self.log: list[dict] = []

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        msg = json.loads(data)
        self.log.append(msg)
        method, params = msg.get("method"), msg.get("params") or {}
        light = self.light
        if method == "getPilot":
            result = {"mac": light["mac"], "rssi": -55, **light["pilot"]}
        elif method == "setPilot":
            p = light["pilot"]
            if "r" in params:
                p.pop("temp", None)
            if "temp" in params:
                for k in ("r", "g", "b"):
                    p.pop(k, None)
            p.update({k: v for k, v in params.items() if k not in ("c", "w")})
            result = {"success": True}
        elif method == "getSystemConfig":
            result = {"mac": light["mac"], "moduleName": light["module"], "fwVersion": "1.38.0"}
        else:
            self.transport.sendto(json.dumps({"method": method, "error": {"code": -32601, "message": "Method not found"}}).encode(), addr)
            return
        self.transport.sendto(json.dumps({"method": method, "env": "pro", "result": result}).encode(), addr)



def addresses_ready() -> bool:
    """Whether each pretend light's loopback address can be used. Linux answers on all of
    127.0.0.0/8; macOS has only 127.0.0.1 until aliases are added
    (`sudo ifconfig lo0 alias 127.0.0.2 up`, and .3 and .4)."""
    for light in LIGHTS:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            try:
                s.bind((light["ip"], 0))
            except OSError:
                return False
    return True


async def serve(port: int = 38899):
    loop = asyncio.get_running_loop()
    bulbs = []
    for light in LIGHTS:
        _, bulb = await loop.create_datagram_endpoint(lambda l=light: Bulb(l), local_addr=(light["ip"], port))
        bulbs.append(bulb)
    return bulbs


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 38899

    async def main():
        await serve(port)
        print(f"{len(LIGHTS)} fake WiZ lights on port {port}")
        await asyncio.Event().wait()

    asyncio.run(main())

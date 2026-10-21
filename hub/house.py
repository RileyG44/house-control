#!/usr/bin/env python3
"""House Control hub: runs on your Mac and drives the lights and air conditioners.

WiZ lights are reached directly over the home network, MRCOOL SmartHVAC air
conditioners through Cielo's cloud. The House Control panel (the web UI in ../web)
is served from here, so any phone or computer on the Wi-Fi can open it.

  python house.py            run the hub
  python house.py install    start it now and whenever you log in
  python house.py uninstall  stop starting it at login
  python house.py scan       list the lights and ACs it can find, then exit
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import plistlib
import socket
import subprocess
import sys
import time
from pathlib import Path

from aiohttp import web
import aiohttp

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import plan as plans  # noqa: E402
from aidot_lan import AidotError, AidotLanClient  # noqa: E402
from mrcool import MrcoolClient, MrcoolError  # noqa: E402
from nowplaying import Adb  # noqa: E402
from tv import TvRemote, default_url as tv_url  # noqa: E402
from wiz import Light, WizClient, WizError  # noqa: E402

PORT = int(os.environ.get("HOUSE_HUB_PORT", "8766"))
CONF = Path(os.environ.get("HOUSE_HUB_DIR", Path.home() / ".house-hub"))
WEB = Path(os.environ.get("HOUSE_HUB_WEB", HERE.parent / "web" / "dist"))
# The Mac app's editor writes here. The site serves CONF/plan.json, so a newer panel file is copied across.
PANEL_PLAN = Path(os.environ.get(
    "HOUSE_PANEL_PLAN",
    Path.home() / "Library/Application Support/HouseControl/plan.json"))
LABEL = "local.househub"

LIGHT_POLL = 2.0     # seconds between reads of every light (local, cheap)
AC_POLL = 90.0       # Cielo's cloud is rate limited
DISCOVER_EVERY = 60.0

log = logging.getLogger("house")


def local_ip() -> str:
    with contextlib.suppress(OSError), socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    return "127.0.0.1"


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


class Hub:
    def __init__(self, conf: Path = CONF):
        self.conf = conf
        conf.mkdir(parents=True, exist_ok=True)
        ip = local_ip()
        subnet = ip.rsplit(".", 1)[0] + ".255" if ip.count(".") == 3 and not ip.startswith("127.") else None
        self.wiz = WizClient(broadcast=["255.255.255.255", *([subnet] if subnet else [])],
                             port=int(os.environ.get("HOUSE_HUB_WIZ_PORT", "38899")))
        self.http: aiohttp.ClientSession | None = None
        self.mrcool: MrcoolClient | None = None
        self.aidot: AidotLanClient | None = None
        self.plan: dict = {}
        self.plan_rev = 0  # bumped whenever the plan changes, so a screen knows which one it shows
        self.links: dict[str, tuple[str, str]] = {}   # plan id -> (service, device id)
        self.state: dict = {"lights": {}, "acs": {}, "features": {}, "offline": []}
        self.listeners: set[asyncio.Queue] = set()
        # The TV, through tv-remote: read often while a panel is open. What it plays comes
        # from the TV over Cast, or adb when that is paired with it.
        self.tv = TvRemote(tv_url(conf, local_ip), self._publish, watched=lambda: bool(self.listeners), adb=Adb.find())
        self._tasks: list[asyncio.Task] = []
        self._ac_due = 0.0

    # ---------- files ----------

    @property
    def names(self) -> dict:
        """devices.json: what each device is called and which room it is in."""
        return read_json(self.conf / "devices.json", {})

    def _remember_lights(self) -> None:
        known = {mac: {"ip": l.ip, "module": l.module, "firmware": l.firmware,
                       "capabilities": l.capabilities, "kelvin": list(l.kelvin)} for mac, l in self.wiz.lights.items()}
        (self.conf / "lights.json").write_text(json.dumps(known, indent=2))

    def _recall_lights(self) -> None:
        for mac, k in read_json(self.conf / "lights.json", {}).items():
            self.wiz.lights[mac] = Light(mac=mac, ip=k["ip"], module=k.get("module", ""), firmware=k.get("firmware", ""),
                                         capabilities=k.get("capabilities", ["brightness"]),
                                         kelvin=tuple(k.get("kelvin", (2700, 6500))), online=False)

    # ---------- lifecycle ----------

    async def start(self) -> None:
        self.http = aiohttp.ClientSession()
        self.tv.http = self.http
        self.mrcool = MrcoolClient(self.conf / "mrcool.json", self.http)
        self.aidot = AidotLanClient(self.conf / "aidot.json", self.http)
        self._recall_lights()
        await self.wiz.start()
        await self.discover()
        if self.mrcool.configured:
            with contextlib.suppress(Exception):
                await self._read_acs()
        if self.aidot.configured:
            try:
                await self.aidot.connect()
                self.aidot.set_known_ips(self._aidot_addresses())
            except AidotError as e:
                log.warning("AiDot: %s", e)
        self._rebuild_plan()
        # The first panel to connect gets the real state, not the panel's defaults.
        await self._poll_lights()
        self._poll_aidot()
        if self.mrcool.devices:
            self._publish_acs()
        self._tasks = [asyncio.create_task(self._loop(self._poll_lights, LIGHT_POLL)),
                       asyncio.create_task(self._loop(self._poll_aidot_loop, LIGHT_POLL)),
                       asyncio.create_task(self._loop(self._poll_acs, 15.0)),
                       asyncio.create_task(self._loop(self._sync_panel_plan, 5.0)),
                       asyncio.create_task(self._loop(self.discover, DISCOVER_EVERY)),
                       asyncio.create_task(self.tv.run())]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        self.wiz.close()
        self.tv.close()
        if self.aidot:
            await self.aidot.close()
        if self.http:
            await self.http.close()

    async def _loop(self, fn, every: float) -> None:
        while True:
            await asyncio.sleep(every)
            try:
                await fn()
            except Exception:
                log.exception("%s failed", fn.__name__)

    # ---------- devices ----------

    def _extra_addresses(self) -> list[str]:
        """Addresses to ask directly besides the broadcast: lights we know, and any IP
        written in devices.json (for networks that drop broadcasts)."""
        ips = {l.ip for l in self.wiz.lights.values()}
        ips |= {v["ip"] for v in (self.names.get("lights") or {}).values() if isinstance(v, dict) and v.get("ip")}
        return sorted(ips)

    async def discover(self) -> None:
        before = set(self.wiz.lights)
        found = await self.wiz.discover(extra=self._extra_addresses())
        if set(self.wiz.lights) != before or found:
            self._remember_lights()
        if set(self.wiz.lights) != before and self.plan:
            self._rebuild_plan()

    async def _read_acs(self) -> None:
        assert self.mrcool
        before = set(self.mrcool.devices)
        await self.mrcool.refresh()
        self._ac_due = time.time() + AC_POLL
        if set(self.mrcool.devices) != before and self.plan:
            self._rebuild_plan()

    def _aidot_addresses(self) -> dict[str, str]:
        """Addresses written in devices.json for AiDot bulbs, by device key."""
        out: dict[str, str] = {}
        for key, v in (self.names.get("lights") or {}).items():
            if isinstance(v, dict) and v.get("ip") and (v.get("service") == "aidot" or key in (self.aidot.devices if self.aidot else {})):
                out[key] = v["ip"]
        if self.aidot:
            for key in self.aidot.devices:
                for v in (self.names.get("lights") or {}).values():
                    props = self.aidot.devices[key].get("properties") or {}
                    if isinstance(v, dict) and v.get("ip") and props.get("ipAddress") == v["ip"]:
                        out[key] = v["ip"]
        return out

    def _adopt_panel_plan(self) -> bool:
        """Copies the Mac panel's floor plan over the hub's when the panel's file is newer.

        The editor saves beside the app, and the site only reads the hub's plan.json.
        Returns whether the hub file's contents changed."""
        panel, hub_plan = PANEL_PLAN, self.conf / "plan.json"
        try:
            if not panel.is_file() or panel.resolve() == hub_plan.resolve():
                return False
            if hub_plan.is_file() and panel.stat().st_mtime_ns <= hub_plan.stat().st_mtime_ns:
                return False
            data = json.loads(panel.read_text())
        except (OSError, ValueError):
            return False
        if not isinstance(data, dict) or not isinstance(data.get("rooms"), list):
            return False
        raw = panel.read_bytes()
        if hub_plan.is_file() and hub_plan.read_bytes() == raw:
            os.utime(hub_plan, ns=(panel.stat().st_mtime_ns, panel.stat().st_mtime_ns))
            return False
        hub_plan.write_bytes(raw)
        os.utime(hub_plan, ns=(panel.stat().st_mtime_ns, panel.stat().st_mtime_ns))
        log.info("Adopted the Mac panel's floor plan")
        return True

    async def _sync_panel_plan(self) -> None:
        if self._adopt_panel_plan():
            self._rebuild_plan()

    def _rebuild_plan(self, by: str | None = None) -> None:
        """Reloads the plan; when it changed, every panel is told (`by`: the screen that saved it)."""
        self._adopt_panel_plan()
        path = self.conf / "plan.json"
        custom = read_json(path, None)
        if custom and custom.get("generatedBy") != "hub" and custom.get("seededBy") != "hub":
            new = custom
        else:
            lights = [l.describe() for l in self.wiz.lights.values()]
            if self.aidot:
                lights += self.aidot.describe_all()
            acs = [self.mrcool.describe(m) for m in self.mrcool.devices] if self.mrcool else []
            # A new hub starts from the default home (Riley's Studio) and keeps re-linking it as
            # devices turn up, until a plan is saved; a hub that already made a plan keeps making it.
            base = plans.template(WEB) if not path.exists() or (custom or {}).get("seededBy") == "hub" else None
            new = plans.seed(base, self.names, lights, acs) if base else plans.build(self.names, lights, acs)
            new = plans.ordered(new, custom)  # the tiles as a screen arranged them, and its scenes
            path.write_text(json.dumps(new, indent=2))
        changed = bool(self.plan) and new != self.plan
        if new != self.plan:
            self.plan_rev += 1
        self.plan = new
        self.links = {d["id"]: (d["link"]["service"], d["link"]["id"])
                      for d in [*new.get("lights", []), *new.get("acs", [])] if (d.get("link") or {}).get("id")}
        if changed:
            # The screen that saved it ignores its own echo; the others take the new plan in place.
            self._publish({"reload": True, "rev": self.plan_rev, "by": by})

    def _plan_ids(self, service: str, device: str) -> list[str]:
        return [pid for pid, (s, d) in self.links.items() if s == service and d == device]

    async def _poll_lights(self) -> None:
        macs = [m for m in self.wiz.lights if self._plan_ids("wiz", m)]
        results = await asyncio.gather(*(self.wiz.read(m) for m in macs), return_exceptions=True)
        update: dict = {"lights": {}}
        for mac, result in zip(macs, results):
            if isinstance(result, Exception):
                continue
            for pid in self._plan_ids("wiz", mac):
                update["lights"][pid] = result
        self._apply(update)

    def _poll_aidot(self) -> None:
        """AiDot bulbs report their own state over their LAN connection; this
        only copies the latest report into the panel state."""
        if not self.aidot:
            return
        update: dict = {"lights": {}}
        for key in list(self.aidot.devices):
            pids = self._plan_ids("aidot", key)
            if not pids:
                continue
            try:
                reading = self.aidot.read(key)
            except AidotError:
                continue
            for pid in pids:
                update["lights"][pid] = reading
        self._apply(update)

    async def _poll_aidot_loop(self) -> None:
        self._poll_aidot()

    async def _poll_acs(self) -> None:
        if not self.mrcool or not self.mrcool.configured or time.time() < self._ac_due:
            return
        try:
            await self._read_acs()
        except MrcoolError as e:
            log.warning("MRCOOL: %s", e)
            self._ac_due = time.time() + AC_POLL
            return
        self._publish_acs()

    def _publish_acs(self) -> None:
        update: dict = {"acs": {}, "features": {}}
        for mac in self.mrcool.devices:
            r = self.mrcool.reading(mac)
            for pid in self._plan_ids("mrcool", mac):
                update["acs"][pid] = r["ac"]
                update["features"][pid] = r["features"]
        self._apply(update)

    def _apply(self, update: dict) -> None:
        """Keeps the last known state and tells the panels what changed."""
        diff: dict = {}
        for section in ("lights", "acs", "features"):
            for pid, value in (update.get(section) or {}).items():
                if self.state[section].get(pid) != value:
                    self.state[section][pid] = value
                    diff.setdefault(section, {})[pid] = value
        if diff:
            self._publish(diff)

    def _publish(self, message: dict) -> None:
        for q in list(self.listeners):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(message)

    # ---------- commands from the panel ----------

    async def command(self, message: dict) -> dict:
        pid = message.get("id")
        patch = message.get("patch") or {}
        state = message.get("state") or {}
        service, device = self.links.get(pid, (None, None))
        if service is None:
            return {"ok": True}  # not linked: simulated in the panel
        try:
            if service == "wiz":
                await self.wiz.send(device, patch, state)
                # Other panels hear it now rather than at the next read.
                light = self.wiz.lights[device]
                self._apply({"lights": {other: dict(light.state) for other in self._plan_ids("wiz", device)}})
            elif service == "aidot":
                if self.aidot is None:
                    return {"error": "AiDot is not signed in yet: see hub/README.md"}
                await self.aidot.send(device, patch, state)
                self._apply({"lights": {other: dict(self.aidot.state.get(device, {}))
                                         for other in self._plan_ids("aidot", device)}})
            elif service == "mrcool":
                await self.mrcool.send(device, patch)
                self._publish_acs()
            else:
                return {"error": f"Unknown platform {service}"}
        except (WizError, MrcoolError, AidotError, aiohttp.ClientError, asyncio.TimeoutError) as e:
            log.warning("%s %s %s: %s", pid, service, patch, e)
            return {"error": str(e) or e.__class__.__name__}
        log.info("%s [%s] %s → ok", pid, service, " ".join(f"{k}={v}" for k, v in sorted(patch.items())))
        return {"ok": True}

    # ---------- the floor plan, edited from any panel ----------

    def save_plan(self, config, by: str | None = None) -> dict:
        """Stores a plan drawn in the editor as the home's plan.

        The hub's plan.json is what the site serves; the Mac app's own plan file, when it
        has one, gets the same bytes (and mtime), so the menu bar panel and the island
        show the same home and neither copy looks newer than the other. `by` is the saving
        screen's client id, passed on in the reload event; the reply carries the plan's rev."""
        if not isinstance(config, dict):
            return {"error": "The plan must be a JSON object"}
        rooms = config.get("rooms")
        if not isinstance(rooms, list) or not rooms:
            return {"error": "The plan needs at least one room"}
        def number(v) -> bool:
            return isinstance(v, (int, float)) and not isinstance(v, bool)

        for r in rooms:
            rect = r.get("rect") if isinstance(r, dict) else None
            poly = r.get("poly") if isinstance(r, dict) else None
            boxed = isinstance(rect, list) and len(rect) == 4 and all(number(v) for v in rect)
            shaped = (isinstance(poly, list) and len(poly) >= 3
                      and all(isinstance(p, list) and len(p) == 2 and all(number(v) for v in p) for p in poly))
            if not (isinstance(r, dict) and r.get("id") and (boxed or shaped)):
                return {"error": "Every room needs an id and a rect [x, z, width, depth] or a poly [[x, z], ...]"}
        if "tileOrder" in config:
            if plans.order_of(config) is None:
                return {"error": "tileOrder must be a list of tile names"}
            config = {**config, "tileOrder": plans.order_of(config)}
        if "scenes" in config:
            if plans.scenes_of(config) is None:
                return {"error": "scenes must be a list of scenes"}
            config = {**config, "scenes": plans.scenes_of(config)}
        # Tiles dragged into a new order, or scenes made, on a plan the hub makes leave it the
        # hub's, so it keeps linking the devices that turn up; anything else makes it drawn by
        # hand from now on.
        hubs = (plans.same_but_order(config, self.plan)
                and (self.plan.get("generatedBy") == "hub" or self.plan.get("seededBy") == "hub"))
        if not hubs:
            config = {k: v for k, v in config.items() if k not in ("generatedBy", "seededBy")}
        data = (json.dumps(config, indent=2) + "\n").encode()
        targets = [self.conf / "plan.json"]
        with contextlib.suppress(OSError):
            if not hubs and PANEL_PLAN.is_file() and PANEL_PLAN.resolve() != targets[0].resolve():
                targets.append(PANEL_PLAN)
        now = time.time_ns()
        for path in targets:
            tmp = path.with_name(path.name + ".saving")
            tmp.write_bytes(data)
            os.replace(tmp, path)
            os.utime(path, ns=(now, now))
        if plans.same_but_order(config, self.plan):
            log.info("Saved the panel's tile order and scenes (%d scenes)", len(config.get("scenes") or []))
        else:
            log.info("Saved the floor plan from the editor (%d rooms)", len(rooms))
        self._rebuild_plan(by=by if isinstance(by, str) and by else None)
        return {"ok": True, "rev": self.plan_rev}

    def services_info(self) -> dict:
        """The platforms the hub drives, in the shape the editor's Connections take."""
        return {
            "wiz": {"connected": True, "local": True},
            "aidot": {"connected": bool(self.aidot and self.aidot.configured), "local": True},
            "mrcool": {"connected": bool(self.mrcool and self.mrcool.configured), "local": True},
        }

    def catalog(self) -> dict:
        """Every device the hub can reach, for the editor's "Real device" pickers."""
        names = self.names.get("lights") or {}
        out = []
        for mac, light in self.wiz.lights.items():
            d = light.describe()
            given = names.get(mac) or {}
            out.append({"service": "wiz", "id": mac, "kind": "light", "name": given.get("name") or d.get("module") or mac,
                        "room": given.get("room", ""), "detail": d.get("ip") or "", "online": d.get("online", False),
                        "capabilities": d.get("capabilities", [])})
        if self.aidot:
            for d in self.aidot.describe_all():
                given = names.get(d["id"]) or next((v for v in names.values() if isinstance(v, dict) and (
                    (v.get("ip") and v["ip"] == d.get("ip")))), {})
                out.append({"service": "aidot", "id": d["id"], "kind": "light", "name": given.get("name") or d.get("module") or d["id"],
                            "room": given.get("room", ""), "detail": d.get("ip") or "", "online": d.get("online", False),
                            "capabilities": d.get("capabilities", [])})
        if self.mrcool:
            acs = self.names.get("acs") or {}
            for mac in self.mrcool.devices:
                d = self.mrcool.describe(mac)
                given = acs.get(mac) or {}
                out.append({"service": "mrcool", "id": mac, "kind": "ac", "name": given.get("name") or d["name"],
                            "room": given.get("room", ""), "detail": f"°{d['unit']}", "online": d["online"],
                            "min": d["min"], "max": d["max"]})
        return {"devices": out, "errors": {}}

    def devices(self) -> dict:
        names = self.names
        lights = [{**l.describe(), **(names.get("lights") or {}).get(m, {}), "linked": self._plan_ids("wiz", m)}
                  for m, l in self.wiz.lights.items()]
        if self.aidot:
            lights += [{**d, **(names.get("lights") or {}).get(d["id"], {}),
                        "linked": self._plan_ids("aidot", d["id"])} for d in self.aidot.describe_all()]
        return {
            "lights": lights,
            "acs": [{**self.mrcool.describe(m), "linked": self._plan_ids("mrcool", m)} for m in self.mrcool.devices]
            if self.mrcool else [],
            "mrcool": {"configured": bool(self.mrcool and self.mrcool.configured)},
            "aidot": {"configured": bool(self.aidot and self.aidot.configured)},
        }


# ---------- web ----------

def _loopback(peer: str | None) -> bool:
    if not peer:
        return False
    if peer.startswith("::ffff:"):
        peer = peer[7:]
    return peer == "::1" or peer.startswith("127.")


def _local_backend(host: str) -> bool:
    """True when Host is the loopback address Tailscale dials, not the public name."""
    name = host
    if name.startswith("["):
        name = name[1:].split("]", 1)[0]
    elif name.count(":") == 1:
        name = name.split(":", 1)[0]
    return name in {"127.0.0.1", "localhost", "::1"}


def panel_origin_ok(request) -> bool:
    """The panel this hub served may send commands. Another site on the LAN may not.

    Tailscale Serve presents the panel at https://<machine>.ts.net and forwards
    plain HTTP from loopback. The browser's origin is that HTTPS URL; the
    connection here is HTTP, so the scheme has to come from X-Forwarded-Proto.
    Forwarded headers are believed only from that local proxy.
    """
    origin = request.headers.get("Origin")
    if not origin:
        return True
    origins = {f"{request.scheme}://{request.host}"}
    if _loopback(request.remote):
        proto = (request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        if proto in {"http", "https"}:
            origins.add(f"{proto}://{request.host}")
            forwarded = (request.headers.get("X-Forwarded-Host") or "").split(",")[0].strip()
            if forwarded and _local_backend(request.host):
                origins.add(f"{proto}://{forwarded}")
    return origin in origins


def make_app(hub: Hub) -> web.Application:
    app = web.Application(client_max_size=2 * 1024 * 1024)  # a plan with lots of furniture

    async def index(_):
        page = WEB / "index.html"
        if not page.is_file():
            return web.Response(status=503, content_type="text/html", text=(
                "<h1>The panel is not built yet</h1><p>Run <code>./setup.sh</code> in the hub folder, "
                "or <code>npm --prefix web ci && npm --prefix web run build</code>.</p>"))
        boot = {"hub": True, "config": hub.plan, "rev": hub.plan_rev}
        html = page.read_text().replace(
            "<head>", "<head><script>window.__HOUSE_BOOT__=" + json.dumps(boot).replace("</", "<\\/") + "</script>", 1)
        return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-store"})

    async def events(request):
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-store"})
        await resp.prepare(request)
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        hub.listeners.add(q)
        try:
            first = {k: hub.state[k] for k in ("lights", "acs", "features")}
            await resp.write(f"data: {json.dumps(first)}\n\n".encode())
            if hub.tv.state is not None:
                # Its own event, so a reader of the first event only (the Mac app) sees what it always did.
                await resp.write(f"data: {json.dumps({'tv': hub.tv.state})}\n\n".encode())
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), 20)
                    await resp.write(f"data: {json.dumps(msg)}\n\n".encode())
                except asyncio.TimeoutError:
                    await resp.write(b": keep-alive\n\n")
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            hub.listeners.discard(q)
        return resp

    async def call(request):
        body = await request.json()
        kind = body.get("type")
        if kind == "command":
            return web.json_response(await hub.command(body))
        if kind == "savePlan":
            return web.json_response(hub.save_plan(body.get("config"), by=body.get("client")))
        if kind == "services.info":
            return web.json_response(hub.services_info())
        if kind == "devices.all":
            return web.json_response(hub.catalog())
        return web.json_response({"error": f"{kind} is not available from the hub"})

    async def devices(_):
        return web.json_response(hub.devices())

    # ---------- the TV (tv.py) ----------

    async def tv_state(_):
        return web.json_response(await hub.tv.current(), headers={"Cache-Control": "no-store"})

    async def tv_action(request):
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "Send JSON"}, status=400)
        result, status = await hub.tv.act(request.match_info["id"], body)
        return web.json_response(result, status=status)

    async def tv_search(request):
        result, status = await hub.tv.search(request.query.get("q", ""))
        return web.json_response(result, status=status)

    async def plan(_):
        return web.json_response(hub.plan, headers={"Cache-Control": "no-store", "X-Plan-Rev": str(hub.plan_rev)})

    async def rescan(_):
        await hub.discover()
        if hub.mrcool and hub.mrcool.configured:
            with contextlib.suppress(MrcoolError):
                await hub._read_acs()
        if hub.aidot and hub.aidot.configured:
            with contextlib.suppress(AidotError):
                await hub.aidot.refresh()
                hub.aidot.set_known_ips(hub._aidot_addresses())
        hub._rebuild_plan()
        return web.json_response(hub.devices())

    async def aidot_login(request):
        body = await request.json()
        email = str(body.get("email") or body.get("username") or "").strip()
        password = str(body.get("password") or "")
        if not email or not password:
            return web.json_response({"error": "Give the email and password of the AiDot app"}, status=400)
        hub.aidot.save_credentials(email, password, str(body.get("country_code") or "US"))
        try:
            await hub.aidot.connect()
        except AidotError as e:
            return web.json_response({"error": str(e)}, status=400)
        hub.aidot.set_known_ips(hub._aidot_addresses())
        hub._rebuild_plan()
        hub._poll_aidot()
        return web.json_response(hub.devices())

    async def mrcool_key(request):
        body = await request.json()
        email = str(body.get("email") or body.get("username") or "").strip()
        password = str(body.get("password") or "")
        try:
            if email and password:
                await hub.mrcool.login(email, password)
            elif body.get("access_token"):
                hub.mrcool.save_web_tokens(body)
            else:
                key = str(body.get("api_key", "")).strip()
                if not key:
                    return web.json_response({"error": "Give the MRCOOL app email and password"}, status=400)
                hub.mrcool.save_key(key)
        except MrcoolError as e:
            return web.json_response({"error": str(e)}, status=400)
        try:
            await hub._read_acs()
        except MrcoolError as e:
            return web.json_response({"error": str(e)}, status=400)
        hub._rebuild_plan()
        hub._publish_acs()
        return web.json_response(hub.devices())

    @web.middleware
    async def same_origin(request, handler):
        # Only the panel this hub serves may send commands (no drive-by pages on the LAN).
        if request.method == "POST" and not panel_origin_ok(request):
            return web.json_response({"error": "Open the panel from the hub itself"}, status=403)
            if request.content_type != "application/json":
                return web.json_response({"error": "Send JSON"}, status=415)
        return await handler(request)

    app.middlewares.append(same_origin)
    app.router.add_get("/", index)
    app.router.add_get("/index.html", index)
    app.router.add_get("/api/events", events)
    app.router.add_post("/api/call", call)
    app.router.add_get("/api/devices", devices)
    app.router.add_get("/api/tv", tv_state)
    app.router.add_get("/api/tv/search", tv_search)
    app.router.add_post("/api/tv/{id}", tv_action)
    app.router.add_get("/api/plan", plan)
    app.router.add_post("/api/rescan", rescan)
    app.router.add_post("/api/mrcool", mrcool_key)
    app.router.add_post("/api/aidot", aidot_login)
    if WEB.is_dir():
        app.router.add_static("/", WEB, show_index=False)

    async def on_startup(_):
        await hub.start()

    async def on_cleanup(_):
        await hub.stop()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


# ---------- login item ----------

PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def install() -> None:
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    CONF.mkdir(parents=True, exist_ok=True)
    with PLIST.open("wb") as f:
        plistlib.dump({
            "Label": LABEL,
            "ProgramArguments": [sys.executable, str(HERE / "house.py")],
            "WorkingDirectory": str(HERE),
            "RunAtLoad": True,
            "KeepAlive": True,
            "StandardOutPath": str(CONF / "hub.log"),
            "StandardErrorPath": str(CONF / "hub.log"),
        }, f)
    subprocess.run(["launchctl", "unload", str(PLIST)], capture_output=True)
    subprocess.run(["launchctl", "load", "-w", str(PLIST)], check=True)
    print(f"House Control hub is running: http://{local_ip()}:{PORT}")
    print("It starts by itself whenever you log in. Log: " + str(CONF / "hub.log"))


def uninstall() -> None:
    subprocess.run(["launchctl", "unload", "-w", str(PLIST)], capture_output=True)
    PLIST.unlink(missing_ok=True)
    print("Stopped. It no longer starts at login.")


async def scan() -> None:
    hub = Hub()
    hub.http = aiohttp.ClientSession()
    hub.mrcool = MrcoolClient(hub.conf / "mrcool.json", hub.http)
    hub.aidot = AidotLanClient(hub.conf / "aidot.json", hub.http)
    hub._recall_lights()
    await hub.wiz.start()
    try:
        await hub.discover()
        if hub.mrcool.configured:
            try:
                await hub._read_acs()
            except MrcoolError as e:
                print("MRCOOL:", e)
        else:
            print("MRCOOL: no sign-in yet (see README.md)")
        if hub.aidot.configured:
            try:
                await hub.aidot.connect()
            except AidotError as e:
                print("AiDot:", e)
        else:
            print("AiDot: no sign-in yet (see README.md)")
        print(json.dumps(hub.devices(), indent=2))
    finally:
        hub.wiz.close()
        if hub.aidot:
            await hub.aidot.close()
        await hub.http.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    # The AiDot library logs device login payloads, including LAN passwords.
    logging.getLogger("aidot").setLevel(logging.WARNING)
    arg = sys.argv[1] if len(sys.argv) > 1 else "run"
    if arg == "install":
        install()
    elif arg == "uninstall":
        uninstall()
    elif arg == "scan":
        asyncio.run(scan())
    else:
        print(f"House Control hub on http://{local_ip()}:{PORT}")
        web.run_app(make_app(Hub()), host="0.0.0.0", port=PORT, print=None)


if __name__ == "__main__":
    main()

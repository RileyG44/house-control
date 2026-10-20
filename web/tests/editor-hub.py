"""Isolated browser fixture: real hub save/SSE routes, no network discovery or hardware.

Run with Python + aiohttp, then `node web/tests/editor.mjs`. All plans live in a
temporary directory. Ports 8777 (hub) and 8778 (plain preview) bind to loopback only.
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'hub'))
import house


class FixtureHub(house.Hub):
    async def start(self):
        self._rebuild_plan()

    async def stop(self):
        pass

    async def discover(self):
        pass

    def catalog(self):
        return {'devices': [{'service': 'wiz', 'id': 'test-bulb', 'kind': 'light',
                            'name': 'Test network lamp', 'room': 'Living Room',
                            'online': True, 'capabilities': ['brightness', 'temp', 'color']}],
                'errors': {}}


async def main():
    with tempfile.TemporaryDirectory(prefix='house-editor-') as folder:
        root = Path(folder)
        raw = json.loads((ROOT / 'web/public/plans/home.json').read_text())
        house.PANEL_PLAN = root / 'panelplan.json'
        house.PANEL_PLAN.write_text(json.dumps(raw))
        hub = FixtureHub(root / 'hub')
        (hub.conf / 'plan.json').write_text(json.dumps(raw))
        app = house.make_app(hub)
        # Lets the browser check the mirrored native plan, never a real user's file.
        runner = web.AppRunner(app, shutdown_timeout=0.2)
        await runner.setup()
        await web.TCPSite(runner, '127.0.0.1', 8777).start()
        plain = web.Application()
        plain.router.add_get('/__test/panel', lambda _: web.json_response(json.loads(house.PANEL_PLAN.read_text())))
        plain.router.add_get('/', lambda _: web.FileResponse(house.WEB / 'index.html'))
        plain.router.add_static('/', house.WEB)
        preview = web.AppRunner(plain)
        await preview.setup()
        await web.TCPSite(preview, '127.0.0.1', 8778).start()
        print('Editor fixture ready: 8777 hub / 8778 preview', flush=True)
        try:
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()
            await preview.cleanup()


if __name__ == '__main__':
    asyncio.run(main())

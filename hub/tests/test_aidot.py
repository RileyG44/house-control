"""python-aidot's receive loop, as the hub guards it (no bulbs or accounts needed)."""
from __future__ import annotations

import asyncio
import errno
import logging
import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import aidot_lan  # noqa: E402

DeviceClient = pytest.importorskip("aidot.device_client").DeviceClient


class LostAddress:
    """A socket whose local address has gone: every read fails at once, without waiting."""

    def __init__(self, give_up_after=50):
        self.reads = 0
        self.give_up_after = give_up_after

    async def readexactly(self, n):
        self.reads += 1
        if self.reads > self.give_up_after:  # ends the unguarded spin so a failing test doesn't hang
            raise ConnectionResetError("test stopped the loop")
        raise OSError(errno.EADDRNOTAVAIL, "Can't assign requested address")


def test_a_bulb_whose_socket_lost_its_address_reconnects_instead_of_spinning():
    async def go():
        client = DeviceClient({"id": "dev1"}, {"id": "user1"}, None)
        client.reader = LostAddress()
        resets = []

        async def reset():
            resets.append(client.reader)

        client.reset = reset
        await asyncio.wait_for(client.receive_data(), 2)
        await asyncio.sleep(0.05)  # the library schedules its reset with call_soon
        return client, resets

    client, resets = asyncio.run(go())
    assert isinstance(client.reader, aidot_lan._LanReader)
    assert client.reader._reader.reads == 1
    assert len(resets) == 1


def test_lan_reader_passes_data_and_the_library_s_own_errors_through():
    class Stream:
        def __init__(self, outcome):
            self.outcome, self.limit = outcome, 65536

        async def readexactly(self, n):
            if isinstance(self.outcome, BaseException):
                raise self.outcome
            return self.outcome[:n]

    async def read(outcome):
        return await aidot_lan._LanReader(Stream(outcome)).readexactly(4)

    assert asyncio.run(read(b"\x1e\xed\x00\x01")) == b"\x1e\xed\x00\x01"
    assert aidot_lan._LanReader(Stream(b"")).limit == 65536
    for passed in (asyncio.IncompleteReadError(b"", 4), BrokenPipeError(), ConnectionResetError()):
        with pytest.raises(type(passed)):
            asyncio.run(read(passed))
    with pytest.raises(ConnectionResetError, match="Can't assign requested address"):
        asyncio.run(read(OSError(errno.EADDRNOTAVAIL, "Can't assign requested address")))
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(read(asyncio.CancelledError()))


def test_guarding_twice_wraps_each_method_once():
    for name, wrap in (("receive_data", aidot_lan._guarded_receive), ("connect", aidot_lan._spaced_connect)):
        guarded = getattr(DeviceClient, name)
        aidot_lan._guard(DeviceClient, name, wrap)
        assert getattr(DeviceClient, name) is guarded and guarded.house_guarded
        assert asyncio.iscoroutinefunction(guarded)


def refused_connections(monkeypatch):
    dialled = []

    async def open_connection(host, port):
        dialled.append((asyncio.get_running_loop().time(), host))
        raise ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused")

    monkeypatch.setattr(asyncio, "open_connection", open_connection)
    monkeypatch.setattr(aidot_lan, "RECONNECT_GAP", 0.3)
    return dialled


def test_reconnects_to_one_bulb_are_spaced_and_hold_off_the_other_paths(monkeypatch):
    dialled = refused_connections(monkeypatch)

    async def go():
        client = DeviceClient({"id": "dev1"}, {"id": "user1"}, None)
        client._ip_address = "192.0.2.10"
        await client.connect("192.0.2.10")  # the first attempt is never held
        second = asyncio.create_task(client.connect("192.0.2.10"))
        await asyncio.sleep(0.05)
        held = client.connecting
        await client.async_login()  # e.g. the minute timer firing meanwhile: stands aside
        await second
        return held, client.connecting

    held, after = asyncio.run(go())
    assert held and not after
    assert len(dialled) == 2 and dialled[1][0] - dialled[0][0] >= 0.25



def test_a_bulb_that_moves_while_its_reconnect_waits_is_dialled_at_its_new_address(monkeypatch):
    dialled = refused_connections(monkeypatch)

    async def go():
        client = DeviceClient({"id": "dev1"}, {"id": "user1"}, None)
        client._ip_address = "192.0.2.10"
        await client.connect(client._ip_address)
        second = asyncio.create_task(client.connect(client._ip_address))
        await asyncio.sleep(0.05)
        client.update_ip_address("192.0.2.11")  # discovery finds it elsewhere; the waiting attempt goes there
        await second

    asyncio.run(go())
    assert [host for _, host in dialled] == ["192.0.2.10", "192.0.2.11"]

def test_a_bulb_closed_while_waiting_is_not_redialled(monkeypatch):
    dialled = refused_connections(monkeypatch)

    async def go():
        client = DeviceClient({"id": "dev1"}, {"id": "user1"}, None)
        await client.connect("192.0.2.10")
        second = asyncio.create_task(client.connect("192.0.2.10"))
        await asyncio.sleep(0.05)
        client._is_close = True
        await second
        return client.connecting

    assert asyncio.run(go()) is False
    assert len(dialled) == 1


def test_repeated_aidot_lines_are_let_through_once_a_minute():
    now = [100.0]
    quiet = aidot_lan.QuietRepeats(clock=lambda: now[0])

    def record(name, msg):
        return logging.LogRecord(name, logging.ERROR, __file__, 1, msg, (), None)

    spin = "f5bd:recv error: [Errno 49] Can't assign requested address"
    assert quiet.filter(record("aidot.device_client", spin))
    assert not any(quiet.filter(record("aidot.device_client", spin)) for _ in range(10000))
    assert quiet.filter(record("aidot.device_client", "f5bd login read status error"))  # a new line
    assert quiet.filter(record("house.aidot", spin))  # the hub's own lines are never held back
    now[0] += 61
    later = record("aidot.device_client", spin)
    assert quiet.filter(later)
    assert later.getMessage() == spin + " (and 10000 more like it in 61s)"
    now[0] += 61
    again = record("aidot.device_client", spin)
    assert quiet.filter(again) and again.getMessage() == spin


def test_every_handler_agrees_with_the_first_and_the_count_is_added_once():
    now = [0.0]
    first, second = aidot_lan.QuietRepeats(clock=lambda: now[0]), aidot_lan.QuietRepeats(clock=lambda: now[0])
    spin = "f5bd:recv error: [Errno 49] Can't assign requested address"

    def through_both():
        r = logging.LogRecord("aidot.device_client", logging.ERROR, __file__, 1, spin, (), None)
        return [first.filter(r), second.filter(r)], r.getMessage()

    assert through_both() == ([True, True], spin)
    for _ in range(5):
        assert through_both()[0] == [False, False]
    now[0] += 61
    assert through_both() == ([True, True], spin + " (and 5 more like it in 61s)")
    assert len(second.seen) == 0  # the second handler never had to decide


def fake_accounts(tmp_path, monkeypatch):
    made, events = [], []

    class Account:
        def __init__(self, session, **kw):
            self.n = len(made)
            made.append(self)

        async def async_post_login(self):
            await asyncio.sleep(0)  # lets a second sign-in run alongside, as two panels might

        async def async_get_all_device(self):
            return {"device_list": [{"id": "dev1", "mac": "d8:47:32:d8:d0:df", "type": "light"}]}

        def get_device_client(self, device):
            events.append(("client", self.n))
            return object()

        async def async_close(self):
            await asyncio.sleep(0)
            events.append(("close", self.n))

    monkeypatch.setattr(aidot_lan, "_AidotClient", Account)
    secret = tmp_path / "aidot.json"
    secret.write_text('{"email": "a@example.com", "password": "x"}')
    return aidot_lan.AidotLanClient(secret, None), made, events


def test_a_rescan_closes_the_previous_connections_first(tmp_path, monkeypatch):
    lights, made, events = fake_accounts(tmp_path, monkeypatch)
    asyncio.run(lights.connect())
    asyncio.run(lights.connect())
    assert events == [("client", 0), ("close", 0), ("client", 1)]
    assert lights.client is made[1]


def test_two_rescans_at_once_leave_only_the_newest_account_running(tmp_path, monkeypatch):
    lights, made, events = fake_accounts(tmp_path, monkeypatch)

    async def go():
        await lights.connect()
        await asyncio.gather(lights.refresh(), lights.refresh())

    asyncio.run(go())
    closed = [n for what, n in events if what == "close"]
    assert closed == [0, 1] and lights.client is made[2]


def test_a_bulb_closed_while_dialling_hangs_up(monkeypatch):
    async def go():
        client = DeviceClient({"id": "dev1"}, {"id": "user1"}, None)
        hung_up = []

        async def open_connection(host, port):
            client._is_close = True  # the hub closes this bulb's client (a rescan) mid-dial
            return LostAddress(), Writer(sock)

        async def login():
            client.status.online = True

        async def reset():
            hung_up.append(client.writer)

        monkeypatch.setattr(asyncio, "open_connection", open_connection)
        client.login, client.reset = login, reset
        await client.connect("192.0.2.10")
        return hung_up

    with socket.socket() as sock:
        assert len(asyncio.run(go())) == 1


class Writer:
    def __init__(self, sock):
        self.sock = sock

    def get_extra_info(self, name):
        return self.sock


def test_a_bulb_s_report_says_whether_it_is_white_or_in_colour():
    from aidot.device_client import DeviceStatusData
    from aidot.models.device_client_model import DeviceAttr

    status = DeviceStatusData()
    status.update(DeviceAttr(OnOff=1, Dimming=10, CCT=2700))  # what a white bulb reports in full
    assert status.house_mode == "white"
    status.update(DeviceAttr(RGBW=0xFF00FF00))  # magenta
    assert status.house_mode == "color" and status.rgbw == (255, 0, 255, 0)
    status.update(DeviceAttr(Dimming=50))  # says nothing about the mode
    assert status.house_mode == "color"
    status.update(DeviceAttr(RGBW=0xFF00FF00, CCT=2700))  # both: no telling
    assert status.house_mode == "color"


def test_reading_a_bulb_uses_the_mode_it_reported_over_the_hub_s_memory(tmp_path):
    from aidot.device_client import DeviceStatusData
    from aidot.models.device_client_model import DeviceAttr

    class Bulb:
        status = DeviceStatusData()

    lights = aidot_lan.AidotLanClient(tmp_path / "aidot.json", None)
    bulb = Bulb()
    bulb.status.online = True
    lights.clients["door"] = bulb
    bulb.status.update(DeviceAttr(OnOff=1, Dimming=10, RGBW=0xFF00FF00))
    lights.modes["door"] = "white"  # e.g. the other hub last sent it a white temperature
    assert lights.read("door")["color"] == "#ff00ff"
    bulb.status.update(DeviceAttr(CCT=2700))
    assert lights.read("door")["color"] is None and lights.read("door")["temp"] == 2700

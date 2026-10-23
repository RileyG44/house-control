"""python-aidot's receive loop, as the hub guards it (no bulbs or accounts needed)."""
from __future__ import annotations

import asyncio
import errno
import logging
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


def test_guarding_twice_wraps_the_loop_once():
    guarded = DeviceClient.receive_data
    aidot_lan._guard_receive_loop(DeviceClient)
    assert DeviceClient.receive_data is guarded and guarded.house_guarded


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

package com.livingroom.tv.house

import org.junit.Assert.*
import org.junit.Test

class PlanRefreshTest {
    @Test fun retriesFailedPlanOnHealthyStreamHeartbeat() {
        var now = 0L
        val refresh = PlanRefresh { now }
        var calls = 0
        assertTrue(refresh.attempt { calls++; error("Wi-Fi lost") }!!.isFailure)
        now = 1000
        assertNull(refresh.attempt { calls++ })
        now = 20_000 // A keep-alive arrives without reconnecting the event stream.
        assertTrue(refresh.attempt { calls++ }!!.isSuccess)
        now = 40_000
        assertNull(refresh.attempt { calls++ })
        assertEquals(2, calls)
    }

    @Test fun failedReloadRetainsPendingWorkUntilRetrySucceeds() {
        var now = 0L
        val refresh = PlanRefresh { now }
        refresh.attempt { }
        refresh.invalidate()
        now = 5000
        assertTrue(refresh.attempt { error("temporary failure") }!!.isFailure)
        now = 10_000
        assertTrue(refresh.attempt { }!!.isSuccess)
        refresh.invalidate() // A reconnect needs the latest plan even when a cached one exists.
        now = 15_000
        assertNotNull(refresh.attempt { })
    }
}

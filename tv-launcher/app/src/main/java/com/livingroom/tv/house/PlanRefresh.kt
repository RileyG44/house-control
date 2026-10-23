package com.livingroom.tv.house

/** Failed plan reads remain pending even if the event stream stays connected. */
internal class PlanRefresh(private val now: () -> Long) {
    private var pending = true
    private var nextAttempt = 0L

    fun invalidate() { pending = true }

    fun attempt(load: () -> Unit): Result<Unit>? {
        if (!pending || now() < nextAttempt) return null
        nextAttempt = now() + 5_000L
        return runCatching(load).onSuccess { pending = false }
    }
}

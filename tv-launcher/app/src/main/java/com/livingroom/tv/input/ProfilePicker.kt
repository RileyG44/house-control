package com.livingroom.tv.input

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import com.livingroom.tv.Graph

/**
 * Gets past an app's "Who's watching?" screen on its own: for a while after an app opens, if
 * its window looks like a profile picker, it selects the profile named in Prefs ("Riley").
 *
 * It only ever acts on a screen that says it is a profile picker (a heading such as "Who's
 * watching") or that shows the profile's name as one of a short row of tiles, and only once per
 * launch. Apps that draw the picker without accessible text are left alone.
 */
object ProfilePicker {
    private const val TAG = "ProfilePicker"
    /** How long after an app opens its picker is looked for. */
    private const val ARMED_MS = 20_000L
    /** Content changes come in bursts; the window is read once they settle. */
    private const val SETTLE_MS = 350L

    private val HEADINGS = Regex(
        "who[’'`]?s watching|who is watching|choose (a |your )?profile|select (a |your )?profile|" +
            "pick (a |your )?profile|switch profiles?|^profiles$|^manage profiles$",
        RegexOption.IGNORE_CASE,
    )

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var armedPkg: String? = null
    @Volatile private var armedUntil = 0L
    private var pending = false

    /** Watch [pkg]'s windows for a profile picker for the next [ARMED_MS]. */
    fun arm(pkg: String) {
        if (pkg.isBlank() || pkg == Graph.app.packageName) return
        armedPkg = pkg
        armedUntil = SystemClock.uptimeMillis() + ARMED_MS
    }

    private fun disarm() { armedPkg = null }

    /** A window of [pkg] appeared or changed: look at it once things settle. */
    fun onWindow(service: AccessibilityService, pkg: String) {
        if (pkg != armedPkg) return
        if (SystemClock.uptimeMillis() > armedUntil) { disarm(); return }
        if (pending) return
        pending = true
        main.postDelayed({
            pending = false
            if (armedPkg == pkg && SystemClock.uptimeMillis() <= armedUntil) check(service, pkg)
        }, SETTLE_MS)
    }

    private fun check(service: AccessibilityService, pkg: String) {
        val root = service.rootInActiveWindow ?: return
        if (root.packageName?.toString() != pkg) return
        val name = Graph.prefs.profile.trim()
        if (name.isEmpty()) { disarm(); return }

        val texts = ArrayList<AccessibilityNodeInfo>()
        var heading = false
        walk(root) { node ->
            val label = label(node)
            if (label != null) {
                if (HEADINGS.containsMatchIn(label)) heading = true
                if (label.equals(name, ignoreCase = true)) texts += node
            }
        }
        val target = texts.firstOrNull() ?: return
        if (!heading && !inTileRow(target)) return

        val tile = ancestor(target) { it.isClickable } ?: ancestor(target) { it.isFocusable }
        disarm()
        if (tile != null && tile.isClickable && tile.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            Log.i(TAG, "Chose profile \"$name\" in $pkg (click)")
            return
        }
        val focusable = tile ?: target
        if (focusable.performAction(AccessibilityNodeInfo.ACTION_FOCUS) || focusable.isFocused) {
            main.postDelayed({ service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DPAD_CENTER) }, 150)
            Log.i(TAG, "Chose profile \"$name\" in $pkg (focus + OK)")
        } else {
            Log.w(TAG, "Found profile \"$name\" in $pkg but couldn't select it")
        }
    }

    /**
     * Whether [node] is one of a short row of profile tiles: its tile's parent holds two to eight
     * tiles, each with a short name. A title or a row of posters doesn't look like that.
     */
    private fun inTileRow(node: AccessibilityNodeInfo): Boolean {
        val tile = ancestor(node) { it.isClickable || it.isFocusable } ?: return false
        val row = tile.parent ?: return false
        val tiles = (0 until row.childCount).mapNotNull { row.getChild(it) }.filter { it.isClickable || it.isFocusable }
        if (tiles.size !in 2..8) return false
        return tiles.all { t ->
            var short = false
            walk(t) { n -> label(n)?.let { if (it.length <= 24) short = true } }
            short
        }
    }

    private fun label(node: AccessibilityNodeInfo): String? =
        (node.text ?: node.contentDescription)?.toString()?.trim()?.takeIf { it.isNotEmpty() }

    private fun ancestor(node: AccessibilityNodeInfo, test: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        var n: AccessibilityNodeInfo? = node
        repeat(5) {
            val cur = n ?: return null
            if (test(cur)) return cur
            n = cur.parent
        }
        return null
    }

    private fun walk(node: AccessibilityNodeInfo, depth: Int = 0, visit: (AccessibilityNodeInfo) -> Unit) {
        if (depth > 30) return
        visit(node)
        for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, depth + 1, visit) }
    }
}

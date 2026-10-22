package com.livingroom.tv.input

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import com.livingroom.tv.Graph
import com.livingroom.tv.media.MediaWatcher

/**
 * Gets past an app's "Who's watching?" screen on its own: for a while after an app opens, if
 * its window looks like a profile picker, it selects the profile named in Prefs ("Riley").
 *
 * It only ever acts on a screen that says it is a profile picker (a heading such as "Who's
 * watching") or that shows the profile's name as one of a short row of tiles, and only once per
 * launch. Apps that draw the picker without accessible text are left alone, except the ones in
 * [BLIND]: after the launcher itself opened one of them from cold, it presses OK once on the
 * profile the app has focused (its last one), when the screen has no readable text and nothing
 * plays. Prefs.profileOk turns that off.
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

    /** Apps whose profile screen has no accessible text (checked with uiautomator, Oct 22). */
    private val BLIND = setOf("com.google.android.youtube.tv", "com.netflix.ninja")
    /** An app last seen longer ago than this starts cold, on its profile screen. */
    private const val COLD_MS = 30 * 60_000L
    /** How long a cold app's first window gets to settle before OK is pressed. */
    private const val BLIND_WAIT_MS = 2_500L

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var armedPkg: String? = null
    @Volatile private var armedUntil = 0L
    private var pending = false
    /** A blind OK waits for this app's first window (set by [arm] with launched = true). */
    @Volatile private var blindPkg: String? = null
    /** When each app was last in front (uptime). */
    private val lastSeen = HashMap<String, Long>()

    /**
     * Watch [pkg]'s windows for a profile picker for the next [ARMED_MS]. [launched] is true when
     * the launcher itself opened it (launch, open, resume), which may allow a blind OK.
     */
    fun arm(pkg: String, launched: Boolean = false) {
        if (pkg.isBlank() || pkg == Graph.app.packageName) return
        val now = SystemClock.uptimeMillis()
        if (launched) {
            val seen = synchronized(lastSeen) { lastSeen[pkg] }
            val cold = Graph.hub.foreground.value != pkg && (seen == null || now - seen > COLD_MS)
            blindPkg = if (cold && pkg in BLIND && Graph.prefs.profileOk) pkg else null
        }
        armedPkg = pkg
        armedUntil = now + ARMED_MS
    }

    /** [pkg] is in front, or was until now: it isn't cold for a while. */
    fun seen(pkg: String) = synchronized(lastSeen) { lastSeen[pkg] = SystemClock.uptimeMillis() }

    private fun disarm() { armedPkg = null; blindPkg = null }

    /** A window of [pkg] appeared or changed: look at it once things settle. */
    fun onWindow(service: AccessibilityService, pkg: String) {
        if (pkg != armedPkg) return
        if (SystemClock.uptimeMillis() > armedUntil) { disarm(); return }
        if (pkg == blindPkg) {
            blindPkg = null
            main.postDelayed({ blindOk(service, pkg) }, BLIND_WAIT_MS)
            return
        }
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
     * OK on the profile the app has focused, once: only while it is still in front, shows no
     * readable text (its profile screen has none; anything else that is readable isn't it), and
     * plays nothing.
     */
    private fun blindOk(service: AccessibilityService, pkg: String) {
        if (armedPkg != pkg) return
        disarm()
        val root = service.rootInActiveWindow ?: return
        if (root.packageName?.toString() != pkg) return
        var readable = false
        walk(root) { if (label(it) != null) readable = true }
        if (readable) { Log.i(TAG, "No OK in $pkg: its screen has text, so it isn't the profile screen"); return }
        if (MediaWatcher.now.value?.let { it.pkg == pkg && it.state == "playing" } == true) {
            Log.i(TAG, "No OK in $pkg: it is already playing"); return
        }
        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DPAD_CENTER)
        Log.i(TAG, "Pressed OK on $pkg's focused profile (cold start)")
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

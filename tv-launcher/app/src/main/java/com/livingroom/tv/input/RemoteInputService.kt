package com.livingroom.tv.input

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.LinearLayout
import android.widget.TextView
import com.livingroom.tv.Graph

/**
 * Carries the phone's arrow keys, OK, Back and typing into whatever app is on screen.
 * Being a system-bound accessibility service also lets the launcher open apps while it's in the background.
 * Enabled over ADB by tools/tv-install.sh; no root.
 */
class RemoteInputService : AccessibilityService() {

    override fun onServiceConnected() {
        Graph.init(application)
        instance = this
        Graph.hub.keysEnabled.value = true
        rootInActiveWindow?.packageName?.toString()?.takeIf { it !in TRANSIENT_WINDOWS }?.let { Graph.hub.foreground.value = it }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                // The active window decides, not the event: apps in the background (Google TV's
                // own Home among them) send window events too.
                val pkg = rootInActiveWindow?.packageName?.toString() ?: event.packageName?.toString() ?: return
                if (pkg in TRANSIENT_WINDOWS) return
                // An app coming to the front, however it was opened, may start on its profile picker.
                val before = Graph.hub.foreground.value
                if (pkg != before) {
                    before?.let { ProfilePicker.seen(it) }
                    ProfilePicker.arm(pkg)
                }
                Graph.hub.foreground.value = pkg
                ProfilePicker.onWindow(this, pkg)
            }
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
                event.packageName?.toString()?.let { ProfilePicker.onWindow(this, it) }
            }
            AccessibilityEvent.TYPE_VIEW_FOCUSED -> {
                Graph.hub.textField.value = event.source?.isEditable == true
            }
        }
    }

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: Intent?): Boolean {
        setPairCode(null)
        instance = null
        Graph.hub.keysEnabled.value = false
        return super.onUnbind(intent)
    }

    // Pairing code, drawn over whatever app is on screen. Accessibility overlays need no extra permission.

    private var pairView: View? = null

    private fun setPairCode(code: String?) {
        val wm = getSystemService(WindowManager::class.java) ?: return
        pairView?.let { runCatching { wm.removeView(it) } }
        pairView = null
        if (code == null) return
        val d = resources.displayMetrics.density
        fun text(value: String, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
            text = value
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
            typeface = Typeface.create("sans-serif", if (bold) Typeface.BOLD else Typeface.NORMAL)
            gravity = Gravity.CENTER
        }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding((36 * d).toInt(), (26 * d).toInt(), (36 * d).toInt(), (28 * d).toInt())
            background = GradientDrawable().apply {
                cornerRadius = 26 * d
                setColor(0xF2141920.toInt())
                setStroke((1 * d).toInt(), 0x2EFFFFFF)
            }
            addView(text("Pair your phone", 17f, 0xFFF5F5F7.toInt(), bold = true))
            addView(text(code.toCharArray().joinToString("\u2009"), 56f, 0xFFFFFFFF.toInt(), bold = true).apply {
                letterSpacing = 0.12f
                fontFeatureSettings = "tnum"
                setPadding(0, (6 * d).toInt(), 0, (4 * d).toInt())
            })
            addView(text("Enter this code in House Control", 14f, 0x99EBEBF5.toInt()))
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = (40 * d).toInt()
            y = (36 * d).toInt()
        }
        runCatching { wm.addView(card, lp); pairView = card }
    }

    companion object {
        @Volatile private var instance: RemoteInputService? = null
        private val main = Handler(Looper.getMainLooper())

        /** Windows that don't change which app the person is using. */
        private val TRANSIENT_WINDOWS = setOf(
            "com.android.systemui", "com.google.android.inputmethod.latin", "android",
            "com.google.android.katniss", "com.google.android.systemui.gtvoverlayx",
            "com.google.android.tv.remote.service",
        )

        val available: Boolean get() = instance != null

        fun key(name: String): Boolean {
            val service = instance ?: return false
            val action = when (name) {
                "up" -> GLOBAL_ACTION_DPAD_UP
                "down" -> GLOBAL_ACTION_DPAD_DOWN
                "left" -> GLOBAL_ACTION_DPAD_LEFT
                "right" -> GLOBAL_ACTION_DPAD_RIGHT
                "center", "ok" -> GLOBAL_ACTION_DPAD_CENTER
                "back" -> GLOBAL_ACTION_BACK
                else -> return false
            }
            return service.performGlobalAction(action)
        }

        /** Replaces the text of whichever field has focus on the TV. */
        fun setText(text: String): Boolean {
            val service = instance ?: return false
            val node = service.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
            if (!node.isEditable) return false
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        }

        /** Presses the keyboard's action key (Search / Go) on the focused field. */
        fun submit(): Boolean {
            val service = instance ?: return false
            val node = service.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
            return node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        }

        /** Shows [code] in the top corner of the TV, or hides it when null. False if the service isn't running. */
        fun showPairCode(code: String?): Boolean {
            val service = instance ?: return false
            main.post { service.setPairCode(code) }
            return true
        }

        /** Puts the Chromecast to sleep; with HDMI-CEC the TV follows. */
        fun sleep(): Boolean = instance?.performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN) ?: false
    }
}

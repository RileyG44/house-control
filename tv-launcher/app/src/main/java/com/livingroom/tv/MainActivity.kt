package com.livingroom.tv

import android.os.Bundle
import android.content.Intent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.livingroom.tv.ui.HomeRoot
import com.livingroom.tv.ui.LivingRoomTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private var homeRequest by mutableIntStateOf(0)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == Intent.ACTION_MAIN && intent.hasCategory(Intent.CATEGORY_HOME)) homeRequest++
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Graph.init(application)
        setContent { LivingRoomTheme { HomeRoot(homeRequest = homeRequest) } }
    }

    override fun onResume() {
        super.onResume()
        Graph.hub.homeVisible.value = true
        if (Graph.apps.all.value.isEmpty()) Graph.scope.launch(Dispatchers.IO) { Graph.apps.refresh() }
        Graph.catalog.refreshIfOld()
        Graph.recommendations.refreshSoon(Graph.scope)
    }

    override fun onPause() {
        Graph.hub.homeVisible.value = false
        super.onPause()
    }
}

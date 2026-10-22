package com.livingroom.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.livingroom.tv.ui.HomeRoot
import com.livingroom.tv.ui.LivingRoomTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Graph.init(application)
        setContent { LivingRoomTheme { HomeRoot() } }
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

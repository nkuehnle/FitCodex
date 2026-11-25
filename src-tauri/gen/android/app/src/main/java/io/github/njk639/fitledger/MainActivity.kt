package io.github.njk639.fitledger

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    HomeWidget.takeIntent(this, intent)
    super.onCreate(savedInstanceState)
    // Keep the web UI clear of the status bar, display cutout and gesture/navigation bar.
    val root = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  // A home-screen widget button tapped while the app was already running.
  override fun onNewIntent(intent: Intent) {
    HomeWidget.takeIntent(this, intent)
    super.onNewIntent(intent)
  }
}

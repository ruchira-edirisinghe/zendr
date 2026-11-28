package dev.zendr.companion

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** A Zendr release on GitHub: its version, what's new, its page and the phone's APK. */
data class Release(val version: String, val notes: String, val page: String, val apk: String?)

/** New versions of the phone app, from the project's GitHub releases. */
object Updates {
    const val REPO = "https://github.com/ruchira-edirisinghe/zendr"
    private const val LATEST = "https://api.github.com/repos/ruchira-edirisinghe/zendr/releases/latest"
    /** How often the app looks on its own. */
    const val EVERY_MS = 2 * 60 * 60 * 1000L

    // What the About screen and the popup show.
    var latest by mutableStateOf<Release?>(null)
        private set
    var checking by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** The release the popup offers, if any. */
    var offer by mutableStateOf<Release?>(null)

    fun installed(context: Context): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "0"

    /** GitHub's latest release, or null when it isn't one (no version tag). */
    fun parse(j: JSONObject): Release? {
        val version = j.optString("tag_name").removePrefix("v").takeIf { it.isNotEmpty() } ?: return null
        val assets = j.optJSONArray("assets")
        val apk = assets?.let { a ->
            (0 until a.length()).map { a.getJSONObject(it) }
                .firstOrNull { it.optString("name").endsWith("-android.apk") }
                ?.optString("browser_download_url")?.takeIf { it.isNotEmpty() }
        }
        val page = j.optString("html_url").takeIf { it.isNotEmpty() } ?: "$REPO/releases/latest"
        return Release(version, j.optString("body"), page, apk)
    }

    /** True when [a] is a later version than [b]: 0.10.0 after 0.9.2, 0.3.0 after 0.3.0-beta.1. */
    fun newer(a: String, b: String): Boolean {
        fun parts(v: String) = v.removePrefix("v").substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
        val x = parts(a)
        val y = parts(b)
        for (i in 0 until maxOf(x.size, y.size)) {
            val p = x.getOrElse(i) { 0 }
            val q = y.getOrElse(i) { 0 }
            if (p != q) return p > q
        }
        return !a.contains('-') && b.contains('-')
    }

    /**
     * A release's notes as plain lines for the phone: its opening line and what's new, without the
     * install table and with the Markdown taken out.
     */
    fun summary(markdown: String, most: Int = 8): String {
        val lines = markdown.replace("\r\n", "\n").lines()
        val intro = lines.takeWhile { !it.startsWith("#") }.map { it.trim() }.filter { it.isNotEmpty() }.take(2)
        val start = lines.indexOfFirst { it.startsWith("#") && it.contains("new", ignoreCase = true) }
        val news = if (start < 0) emptyList() else lines.drop(start + 1).takeWhile { !it.startsWith("#") }
            .map { it.trim() }.filter { it.startsWith("- ") || it.startsWith("* ") }.take(most)
            .map { "• " + it.drop(2) }
        // The opening as a paragraph, then the list.
        return listOf(intro.joinToString(" ") { plain(it) }, news.joinToString("\n") { plain(it) })
            .filter { it.isNotEmpty() }.joinToString("\n\n")
    }

    private fun plain(s: String) = s
        .replace(Regex("\\[([^]]+)]\\([^)]+\\)"), "$1")
        .replace("**", "").replace("`", "")
        .trim()

    private suspend fun fetch(): Release = withContext(Dispatchers.IO) {
        val conn = URL(LATEST).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 8000
            conn.readTimeout = 15000
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.setRequestProperty("User-Agent", "Zendr-Android")
            val code = conn.responseCode
            if (code != 200) {
                throw IOException(if (code == 403 || code == 429) "GitHub is busy. Try again in a few minutes." else "GitHub said: error $code")
            }
            parse(JSONObject(conn.inputStream.bufferedReader().use { it.readText() })) ?: throw IOException("No release there yet.")
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Asks GitHub for the newest version. A newer one is offered in a popup: always when you asked
     * ([manual]), otherwise unless you chose to skip it.
     */
    suspend fun check(context: Context, store: Store, manual: Boolean) {
        if (checking) return
        checking = true
        error = null
        try {
            val r = fetch()
            store.updateCheckedAt = System.currentTimeMillis()
            latest = r
            if (newer(r.version, installed(context))) {
                Feed.noteUpdate(store, r)
                if (manual || r.version != store.skipVersion) offer = r
            }
        } catch (e: Exception) {
            error = if (e is IOException && e.message?.startsWith("GitHub") == true) e.message
            else "Couldn't reach GitHub. Check your internet connection."
        } finally {
            checking = false
        }
    }

    /** Looks on its own when it's been a while. */
    suspend fun checkNow(context: Context, store: Store) {
        if (System.currentTimeMillis() - store.updateCheckedAt >= EVERY_MS) check(context, store, manual = false)
    }
}

/** "A new version is here": what's new, and the APK to download. */
@Composable
fun UpdateDialog(release: Release, installed: String, onSkip: () -> Unit, onClose: () -> Unit) {
    val uri = LocalUriHandler.current
    AlertDialog(
        onDismissRequest = onClose,
        icon = { ZendrLogo(56.dp) },
        title = { Text("Zendr ${release.version} is here", textAlign = TextAlign.Center) },
        text = {
            Column {
                Text("You have $installed. The update keeps your computers and settings.", fontSize = 14.sp)
                val notes = Updates.summary(release.notes)
                if (notes.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    Text("What's new", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Spacer(Modifier.height(4.dp))
                    Column(Modifier.heightIn(max = 220.dp).verticalScroll(rememberScrollState())) {
                        Text(notes, fontSize = 13.sp, lineHeight = 19.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "Download opens the APK in your browser. Open it when it's done to install.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            Button(onClick = { runCatching { uri.openUri(release.apk ?: release.page) }; onClose() }) { Text("Download") }
        },
        dismissButton = {
            Row {
                TextButton(onClick = onSkip) { Text("Skip") }
                TextButton(onClick = onClose) { Text("Later") }
            }
        },
    )
}

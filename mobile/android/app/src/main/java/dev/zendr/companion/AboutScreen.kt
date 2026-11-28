package dev.zendr.companion

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/** About Zendr: the version, updates, light or dark, and where the project lives. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(store: Store, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    val installed = remember { Updates.installed(context) }
    fun open(url: String) = runCatching { uri.openUri(url) }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("About") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        )
    }) { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // The iguana, the name, the version.
            Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                val green = MaterialTheme.colorScheme.primary
                Box(
                    Modifier.size(120.dp).background(Brush.radialGradient(listOf(green.copy(alpha = 0.28f), green.copy(alpha = 0f))), CircleShape),
                    contentAlignment = Alignment.Center,
                ) { ZendrLogo(88.dp) }
                Text("Zendr", fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(50)) {
                    Text(
                        "Version $installed", fontSize = 13.sp, fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    "Your terminals and coding agents, in your pocket. See who needs you, read their screens and answer from anywhere.",
                    textAlign = TextAlign.Center, fontSize = 15.sp, lineHeight = 21.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 8.dp),
                )
            }

            // Updates
            Card {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Tile(Glyphs.Download)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Updates", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                        val latest = Updates.latest
                        val line = when {
                            Updates.checking -> "Looking for a new version…"
                            Updates.error != null -> Updates.error!!
                            latest != null && Updates.newer(latest.version, installed) -> "Zendr ${latest.version} is out"
                            latest != null -> "You have the newest version"
                            store.updateCheckedAt > 0 -> "Checked " + DateUtils.getRelativeTimeSpanString(store.updateCheckedAt).toString().lowercase()
                            else -> "Zendr looks for new versions by itself"
                        }
                        Text(line, fontSize = 13.sp, color = if (Updates.error != null) Red else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.width(8.dp))
                    val latest = Updates.latest
                    if (latest != null && Updates.newer(latest.version, installed) && !Updates.checking) {
                        Button(onClick = { Updates.offer = latest }) { Text("Get it") }
                    } else {
                        FilledTonalButton(onClick = { scope.launch { Updates.check(context, store, manual = true) } }, enabled = !Updates.checking) {
                            Text("Check")
                        }
                    }
                }
            }

            // Light or dark
            Card {
                Column(Modifier.padding(16.dp)) {
                    Text("Appearance", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    Spacer(Modifier.height(10.dp))
                    val choices = listOf("system" to "Like the phone", "light" to "Light", "dark" to "Dark")
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        choices.forEachIndexed { i, (value, label) ->
                            SegmentedButton(
                                selected = Appearance.theme == value,
                                onClick = { Appearance.set(store, value) },
                                shape = SegmentedButtonDefaults.itemShape(i, choices.size),
                                label = { Text(label, maxLines = 1, fontSize = 13.sp) },
                            )
                        }
                    }
                }
            }

            // Where it lives
            Card {
                Column {
                    LinkRow(Glyphs.Code, "Source code", "github.com/ruchira-edirisinghe/zendr") { open(Updates.REPO) }
                    Divider()
                    LinkRow(Glyphs.Download, "All releases", "Zendr for Windows, Mac and Android") { open("${Updates.REPO}/releases") }
                    Divider()
                    LinkRow(Glyphs.Book, "Using the phone app", "Pairing, alerts and the terminal") { open("${Updates.REPO}#zendr-on-your-phone") }
                    Divider()
                    LinkRow(Glyphs.Alert, "Report a problem", "Open an issue on GitHub") { open("${Updates.REPO}/issues/new") }
                    Divider()
                    LinkRow(Glyphs.Licence, "Licence", "Apache 2.0, free and open source") { open("${Updates.REPO}/blob/main/LICENSE") }
                    Divider()
                    LinkRow(Glyphs.Heart, "Made from Herdr", "herdr.dev") { open("https://herdr.dev") }
                }
            }

            Text(
                "Your terminals go only between this phone and your computers, over your own Tailscale network. The app asks GitHub for new versions, nothing else.",
                fontSize = 12.sp, lineHeight = 17.sp, textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) { content() }
}

@Composable
private fun Divider() = HorizontalDivider(Modifier.padding(start = 68.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))

@Composable
private fun Tile(icon: ImageVector) {
    Box(Modifier.size(38.dp).background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(11.dp)), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun LinkRow(icon: ImageVector, title: String, detail: String, onClick: () -> Unit) {
    Surface(onClick = onClick, color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Tile(icon)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.Medium, fontSize = 15.sp)
                Text(detail, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Glyphs.Open, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
    }
}

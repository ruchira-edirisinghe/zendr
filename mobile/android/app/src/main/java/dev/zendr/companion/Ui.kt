package dev.zendr.companion

import androidx.compose.animation.Crossfade
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val Green = Color(0xFF2FBF71)
val Red = Color(0xFFE5534B)
val Amber = Color(0xFFE0A030)

/** Light, dark, or as the phone is set ("light", "dark", "system"), for the whole app. */
object Appearance {
    var theme by mutableStateOf("system")
        private set

    fun load(store: Store) { theme = store.theme }

    fun set(store: Store, value: String) {
        theme = value
        store.theme = value
    }
}

@Composable
fun isDark(theme: String = Appearance.theme): Boolean = when (theme) {
    "light" -> false
    "dark" -> true
    else -> isSystemInDarkTheme()
}

@Composable
fun ZendrTheme(theme: String = Appearance.theme, content: @Composable () -> Unit) {
    val dark = isDark(theme)
    val scheme = if (dark) {
        darkColorScheme(
            primary = Green, onPrimary = Color(0xFF06210F),
            primaryContainer = Color(0xFF1F5C3A), onPrimaryContainer = Color(0xFFC6F2D6),
            background = Color(0xFF15171A), surface = Color(0xFF15171A),
            surfaceVariant = Color(0xFF22252A), onSurfaceVariant = Color(0xFFB7BCC4),
            surfaceContainer = Color(0xFF1C1F23), surfaceContainerHigh = Color(0xFF24282D),
            secondaryContainer = Color(0xFF203A2B), onSecondaryContainer = Color(0xFFBFEBD0),
            outlineVariant = Color(0xFF2E3238),
        )
    } else {
        // Soft grey paper with white cards, the same green.
        lightColorScheme(
            primary = Color(0xFF1E8A50), onPrimary = Color.White,
            primaryContainer = Color(0xFFC9EFD8), onPrimaryContainer = Color(0xFF0B3B21),
            background = Color(0xFFF4F5F7), onBackground = Color(0xFF16191D),
            surface = Color(0xFFF4F5F7), onSurface = Color(0xFF16191D),
            surfaceVariant = Color(0xFFE6E9ED), onSurfaceVariant = Color(0xFF59606A),
            surfaceContainer = Color.White, surfaceContainerHigh = Color(0xFFFFFFFF), surfaceContainerHighest = Color(0xFFE9ECEF),
            secondaryContainer = Color(0xFFD5F2E1), onSecondaryContainer = Color(0xFF0B3B21),
            outlineVariant = Color(0xFFDCE0E5),
        )
    }
    MaterialTheme(colorScheme = scheme) { Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() } }
}

/** The colour that says what a session is doing (as Zendr on the computer colours it). */
@Composable
fun statusColor(status: String?): Color = when (status) {
    "blocked" -> Red
    "working" -> Amber
    "done" -> Green
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
fun StatusChip(status: String?, compact: Boolean = false) {
    val color = statusColor(status)
    Row(
        Modifier.background(color.copy(alpha = 0.16f), RoundedCornerShape(50))
            .padding(horizontal = if (compact) 8.dp else 10.dp, vertical = if (compact) 3.dp else 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(statusLabel(status), color = color, fontSize = if (compact) 11.sp else 12.sp, fontWeight = FontWeight.Medium)
    }
}

/** A round badge for what runs in a session: the agent's mark, or a prompt for a shell. */
@Composable
fun AppBadge(app: String?, size: Dp = 40.dp) {
    val (mark, tile) = when (app) {
        "claude-code", "claude" -> "✳" to Color(0xFFD97757)
        "codex" -> "◎" to Color(0xFF3B3F46)
        "gemini" -> "✦" to Color(0xFF4F7FE8)
        "opencode" -> "oc" to Color(0xFF4B5563)
        "amp" -> "A" to Color(0xFFE5484D)
        "pi" -> "π" to Color(0xFF6D5BD0)
        "cursor-agent", "cursor" -> "▲" to Color(0xFF2A2E35)
        "copilot", "github-copilot" -> "◉" to Color(0xFF6E40C9)
        null -> ">_" to Color(0xFF2B3036)
        else -> app.take(1).uppercase() to Color(0xFF4E5D94)
    }
    Box(Modifier.size(size).background(tile, RoundedCornerShape(size / 3.6f)), contentAlignment = Alignment.Center) {
        Text(
            mark, color = Color.White, fontWeight = FontWeight.Bold,
            fontSize = (size.value * if (mark.length > 1) 0.34f else 0.46f).sp,
            fontFamily = if (app == null) FontFamily.Monospace else FontFamily.Default,
        )
    }
}

/** A space's avatar: its first letter on a colour of its own, as in Zendr's sidebar. */
@Composable
fun SpaceAvatar(name: String, size: Dp = 22.dp) {
    val palette = listOf(0xFF22A99A, 0xFFE3814F, 0xFF5B8DEF, 0xFF8B7CF6, 0xFF3FAE6A, 0xFFD9649A)
    val tile = Color(palette[(name.hashCode() and 0x7fffffff) % palette.size])
    Box(Modifier.size(size).background(tile, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
        Text(name.take(1).uppercase().ifEmpty { "·" }, color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.55f).sp)
    }
}

/** Zendr's iguana. */
@Composable
fun ZendrLogo(size: Dp, modifier: Modifier = Modifier) {
    Image(painterResource(R.drawable.zendr_logo), null, modifier.size(size))
}

/** The app's own bar: the iguana and the name in the middle. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ZendrTopBar(navigationIcon: @Composable () -> Unit = {}, actions: @Composable RowScope.() -> Unit = {}) {
    CenterAlignedTopAppBar(
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ZendrLogo(30.dp)
                Spacer(Modifier.width(8.dp))
                Text("Zendr", fontWeight = FontWeight.Bold, fontSize = 21.sp)
            }
        },
        navigationIcon = navigationIcon,
        actions = actions,
    )
}

/** Flips between light and dark (from "as the phone is", whichever it isn't now). */
@Composable
fun ThemeButton(store: Store) {
    val dark = isDark()
    IconButton(onClick = { Appearance.set(store, if (dark) "light" else "dark") }) {
        Crossfade(dark, label = "theme") { d ->
            Icon(if (d) Glyphs.Sun else Glyphs.Moon, if (d) "Light mode" else "Dark mode")
        }
    }
}

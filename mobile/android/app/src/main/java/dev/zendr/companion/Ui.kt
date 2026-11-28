package dev.zendr.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val Green = Color(0xFF2FBF71)
val Red = Color(0xFFE5534B)
val Amber = Color(0xFFE0A030)

@Composable
fun ZendrTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val scheme = if (dark) {
        darkColorScheme(
            primary = Green, onPrimary = Color(0xFF06210F),
            background = Color(0xFF15171A), surface = Color(0xFF15171A),
            surfaceVariant = Color(0xFF22252A), onSurfaceVariant = Color(0xFFB7BCC4),
            surfaceContainer = Color(0xFF1C1F23), surfaceContainerHigh = Color(0xFF24282D),
            secondaryContainer = Color(0xFF203A2B), onSecondaryContainer = Color(0xFFBFEBD0),
            outlineVariant = Color(0xFF2E3238),
        )
    } else {
        lightColorScheme(
            primary = Color(0xFF1E8A50), onPrimary = Color.White,
            surfaceVariant = Color(0xFFEDEFF2), surfaceContainer = Color(0xFFF3F4F6),
            secondaryContainer = Color(0xFFD5F2E1), onSecondaryContainer = Color(0xFF0B3B21),
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

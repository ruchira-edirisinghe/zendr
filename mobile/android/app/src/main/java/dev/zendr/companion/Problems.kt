package dev.zendr.companion

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Tailscale on this phone: is it on, and opening it. */
object Tailscale {
    const val PACKAGE = "com.tailscale.ipn"

    /** True when a VPN (Tailscale is one on Android) is up on this phone; null when it can't tell. */
    @Suppress("DEPRECATION")
    fun on(context: Context): Boolean? = runCatching {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }
    }.getOrNull()

    /** Opens the Tailscale app, or its store page when it isn't installed. */
    fun open(context: Context) {
        val app = context.packageManager.getLaunchIntentForPackage(PACKAGE)
        val store = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$PACKAGE"))
        val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$PACKAGE"))
        for (i in listOfNotNull(app, store, web)) {
            if (runCatching { context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return
        }
    }
}

/** How many failed looks in a row before the connection help pops up by itself. */
const val HELP_AFTER = 2

/**
 * "This isn't working": what to check when the phone can't reach a computer (Tailscale on both,
 * the same account, Zendr open there), then try again.
 */
@Composable
fun ConnectionHelp(name: String, onRetry: () -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val here = remember { Tailscale.on(context) }
    AlertDialog(
        onDismissRequest = onClose,
        icon = { ProblemArt(Problem.Offline, width = 168.dp) },
        title = { Text("Can't connect to $name", textAlign = TextAlign.Center) },
        text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("This phone and $name aren't talking right now. Check these, then try again:", fontSize = 14.sp)
                CheckItem(
                    1, here, "Tailscale is on, on this phone",
                    when (here) {
                        false -> "It looks off. Open Tailscale and connect."
                        true -> "It's on."
                        null -> "Open Tailscale and check it says Connected."
                    },
                )
                CheckItem(2, null, "Tailscale is on, on the computer", "Signed in to the same account as this phone.")
                CheckItem(3, null, "Zendr is open on the computer", "With Settings → Phone turned on, and the computer awake.")
            }
        },
        confirmButton = { Button(onClick = onRetry) { Text("Try again") } },
        dismissButton = {
            Row {
                TextButton(onClick = { Tailscale.open(context) }) { Text("Open Tailscale") }
                TextButton(onClick = onClose) { Text("Close") }
            }
        },
    )
}

@Composable
private fun CheckItem(n: Int, ok: Boolean?, title: String, detail: String) {
    Row(verticalAlignment = Alignment.Top) {
        val (tile, ink) = when (ok) {
            true -> Green to Color.White
            false -> Red to Color.White
            null -> MaterialTheme.colorScheme.secondaryContainer to MaterialTheme.colorScheme.onSecondaryContainer
        }
        Box(Modifier.size(26.dp).background(tile, CircleShape), contentAlignment = Alignment.Center) {
            when (ok) {
                true -> Icon(Icons.Default.Check, null, tint = ink, modifier = Modifier.size(16.dp))
                false -> Icon(Glyphs.Cross, null, tint = ink, modifier = Modifier.size(14.dp))
                null -> Text("$n", color = ink, fontWeight = FontWeight.Bold, fontSize = 13.sp)
            }
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text(title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            Text(detail, fontSize = 13.sp, color = if (ok == false) Red else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * A picture of what went wrong: the phone and the computer with what's between them, or a 404
 * with the iguana for the zero when what you opened isn't there.
 */
@Composable
fun ProblemArt(problem: Problem, width: Dp = 240.dp) {
    val k = width / 240.dp
    if (problem == Problem.Gone || problem == Problem.Missing) {
        val ink = MaterialTheme.colorScheme.primary
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("4", fontSize = (96 * k).sp, fontWeight = FontWeight.Black, color = ink, fontFamily = FontFamily.Monospace)
            ZendrLogo((84 * k).dp)
            Text("4", fontSize = (96 * k).sp, fontWeight = FontWeight.Black, color = ink, fontFamily = FontFamily.Monospace)
        }
        return
    }
    val accent = when (problem) {
        Problem.Server -> Amber
        Problem.Outdated -> MaterialTheme.colorScheme.primary
        else -> Red
    }
    val glyph = when (problem) {
        Problem.Unpaired -> Glyphs.Unlink
        Problem.Outdated -> Glyphs.Up
        Problem.Server -> Glyphs.Bang
        else -> Glyphs.Cross
    }
    val ink = MaterialTheme.colorScheme.onSurfaceVariant
    Box(Modifier.size(width, width * 0.54f), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val mid = size.height / 2
            drawCircle(
                Brush.radialGradient(listOf(accent.copy(alpha = 0.20f), accent.copy(alpha = 0f)), center, size.height * 0.75f),
                radius = size.height * 0.75f,
            )
            // One unit of the drawing (it's laid out at 240 wide).
            val d = size.width / 240f
            val stroke = Stroke(3.2f * d, cap = StrokeCap.Round)
            // The phone, on the left.
            val pw = 34 * d
            val ph = 60 * d
            val px = 16 * d
            val py = mid - ph / 2
            drawRoundRect(ink, Offset(px, py), Size(pw, ph), CornerRadius(9 * d), style = stroke)
            drawLine(ink, Offset(px + pw / 2 - 5 * d, py + ph - 8 * d), Offset(px + pw / 2 + 5 * d, py + ph - 8 * d), 3.2f * d, StrokeCap.Round)
            // The computer, on the right.
            val lw = 62 * d
            val lh = 40 * d
            val lx = size.width - 22 * d - lw
            val ly = mid - lh / 2 - 6 * d
            drawRoundRect(ink, Offset(lx, ly), Size(lw, lh), CornerRadius(6 * d), style = stroke)
            drawLine(ink, Offset(lx - 8 * d, ly + lh + 9 * d), Offset(lx + lw + 8 * d, ly + lh + 9 * d), 3.2f * d, StrokeCap.Round)
            drawLine(ink.copy(alpha = 0.5f), Offset(lx + 10 * d, ly + 12 * d), Offset(lx + 28 * d, ly + 12 * d), 3.2f * d, StrokeCap.Round)
            drawLine(ink.copy(alpha = 0.5f), Offset(lx + 10 * d, ly + 21 * d), Offset(lx + 38 * d, ly + 21 * d), 3.2f * d, StrokeCap.Round)
            // What's between them.
            drawLine(
                ink.copy(alpha = 0.55f), Offset(px + pw + 12 * d, mid), Offset(lx - 12 * d, mid), 3.2f * d, StrokeCap.Round,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(1f, 10 * d)),
            )
        }
        Box(Modifier.size(width * 0.16f).background(accent, CircleShape), contentAlignment = Alignment.Center) {
            Icon(glyph, null, tint = Color.White, modifier = Modifier.size(width * 0.09f))
        }
    }
}

/**
 * A whole screen for when something can't be shown: what happened, in plain words, and the way out.
 * [onRetry] tries again; [onHelp] shows what to check; [onPair] scans the code again; [onBack]
 * goes back to where you were.
 */
@Composable
fun ProblemView(
    problem: Problem,
    name: String,
    detail: String? = null,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
    onHelp: (() -> Unit)? = null,
    onPair: (() -> Unit)? = null,
    onBack: (() -> Unit)? = null,
) {
    val uri = LocalUriHandler.current
    val (title, body) = when (problem) {
        Problem.Offline -> "Can't reach $name" to
            "This phone and $name aren't connected right now. Check that Tailscale is on, on both, and that Zendr is open on the computer."
        Problem.Unpaired -> "This phone was unpaired" to
            "$name has a new pairing code, so this phone can't get in any more. Show the code in Settings → Phone on the computer and scan it again."
        Problem.Gone -> "This session has ended" to
            "It was closed on $name, or Zendr there started over. Your other sessions are still there."
        Problem.Outdated -> "Update Zendr on $name" to
            "This phone app needs a newer Zendr on the computer. Install the newest one there: your terminals keep running."
        Problem.Server -> "$name ran into a problem" to
            "Zendr there didn't answer the way it should. Try again in a moment."
        Problem.Missing -> "Computer not found" to
            "That computer isn't paired with this phone any more."
    }
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        ProblemArt(problem)
        Spacer(Modifier.height(20.dp))
        Text(title, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(body, fontSize = 15.sp, lineHeight = 21.sp, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (problem == Problem.Server && !detail.isNullOrBlank()) {
            Spacer(Modifier.height(14.dp))
            Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(10.dp)) {
                Text(
                    detail, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
        Spacer(Modifier.height(24.dp))
        val wide = Modifier.fillMaxWidth(0.8f).height(48.dp)
        // The main way out first, then the others.
        when (problem) {
            Problem.Offline -> {
                onRetry?.let { Button(onClick = it, modifier = wide) { Text("Try again") } }
                onHelp?.let { Spacer(Modifier.height(10.dp)); OutlinedButton(onClick = it, modifier = wide) { Text("What to check") } }
            }
            Problem.Unpaired -> {
                onPair?.let { Button(onClick = it, modifier = wide) { Text("Scan the code again") } }
                onBack?.let { Spacer(Modifier.height(10.dp)); OutlinedButton(onClick = it, modifier = wide) { Text("Back") } }
            }
            Problem.Gone, Problem.Missing -> {
                onBack?.let { Button(onClick = it, modifier = wide) { Text(if (problem == Problem.Gone) "Back to the sessions" else "Back to your computers") } }
            }
            Problem.Outdated -> {
                Button(onClick = { runCatching { uri.openUri("${Updates.REPO}/releases/latest") } }, modifier = wide) { Text("Get the newest Zendr") }
                onRetry?.let { Spacer(Modifier.height(10.dp)); OutlinedButton(onClick = it, modifier = wide) { Text("Try again") } }
            }
            Problem.Server -> {
                onRetry?.let { Button(onClick = it, modifier = wide) { Text("Try again") } }
                Spacer(Modifier.height(10.dp))
                OutlinedButton(onClick = { runCatching { uri.openUri("${Updates.REPO}/issues/new") } }, modifier = wide) { Text("Report a problem") }
            }
        }
    }
}

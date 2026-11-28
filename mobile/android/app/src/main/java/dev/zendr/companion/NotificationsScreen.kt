package dev.zendr.companion

import android.Manifest
import android.os.Build
import android.text.format.DateUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Calendar

/** The bell in the bar, with how many you haven't seen. */
@Composable
fun BellButton(store: Store, onClick: () -> Unit) {
    val unread = remember(Feed.version) { Feed.unread(store) }
    IconButton(onClick = onClick) {
        BadgedBox(badge = { if (unread > 0) Badge { Text(if (unread > 99) "99+" else "$unread") } }) {
            Icon(Icons.Default.Notifications, if (unread > 0) "Notifications, $unread new" else "Notifications")
        }
    }
}

/** Everything that happened: agents that needed you or finished, and new versions. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationsScreen(store: Store, onBack: () -> Unit, onOpen: (Note) -> Unit) {
    val context = LocalContext.current
    val notes = remember(Feed.version) { Feed.list(store) }
    var menu by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }
    var alerts by remember { mutableStateOf(store.alerts) }
    val notifyPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    // New ones keep their dot while you look; leaving marks them all seen.
    DisposableEffect(Unit) { onDispose { Feed.markRead(store) } }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Notifications") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            actions = {
                if (notes.isNotEmpty()) {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Mark all as read") }, onClick = { menu = false; Feed.markRead(store) })
                        DropdownMenuItem(text = { Text("Clear all") }, onClick = { menu = false; confirmClear = true })
                    }
                }
            },
        )
    }) { pad ->
        if (notes.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(pad).padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                val green = MaterialTheme.colorScheme.primary
                Box(
                    Modifier.size(132.dp).background(Brush.radialGradient(listOf(green.copy(alpha = 0.22f), green.copy(alpha = 0f))), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(76.dp).background(MaterialTheme.colorScheme.secondaryContainer, CircleShape), contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Notifications, null, tint = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.size(36.dp))
                    }
                }
                Spacer(Modifier.height(18.dp))
                Text("All caught up", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                Text(
                    "When an agent needs you or finishes, or a new Zendr is out, you'll find it here.",
                    textAlign = TextAlign.Center, fontSize = 15.sp, lineHeight = 21.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!alerts) {
                    Spacer(Modifier.height(20.dp))
                    Text(
                        "Turn on Alert me to catch them while the app is closed too.",
                        textAlign = TextAlign.Center, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(10.dp))
                    Button(onClick = {
                        alerts = true
                        store.alerts = true
                        if (Build.VERSION.SDK_INT >= 33) notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        WatchService.start(context)
                    }) { Text("Turn on Alert me") }
                }
            }
        } else {
            LazyColumn(
                Modifier.fillMaxSize().padding(pad),
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                notes.groupBy { day(it.at) }.forEach { (label, group) ->
                    item(key = "day-$label") {
                        Text(
                            label, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 4.dp, top = 10.dp, bottom = 2.dp),
                        )
                    }
                    items(group, key = { it.id }) { n -> NoteRow(store, n, onOpen) }
                }
                item {
                    Text(
                        "Swipe one away to remove it.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    )
                }
            }
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Clear all notifications?") },
            text = { Text("They're only on this phone. Your sessions aren't touched.") },
            confirmButton = { TextButton(onClick = { Feed.clear(store); confirmClear = false }) { Text("Clear") } },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NoteRow(store: Store, n: Note, onOpen: (Note) -> Unit) {
    val swipe = rememberSwipeToDismissBoxState(confirmValueChange = {
        if (it != SwipeToDismissBoxValue.Settled) Feed.remove(store, n.id)
        it != SwipeToDismissBoxValue.Settled
    })
    SwipeToDismissBox(
        swipe,
        backgroundContent = {
            if (swipe.dismissDirection != SwipeToDismissBoxValue.Settled) Box(
                Modifier.fillMaxSize().background(Red.copy(alpha = 0.16f), RoundedCornerShape(16.dp)).padding(horizontal = 20.dp),
                contentAlignment = if (swipe.dismissDirection == SwipeToDismissBoxValue.EndToStart) Alignment.CenterEnd else Alignment.CenterStart,
            ) { Icon(Icons.Default.Delete, "Remove", tint = Red) }
        },
    ) {
        val accent = when (n.kind) {
            "blocked" -> Red
            "done" -> Green
            else -> MaterialTheme.colorScheme.primary
        }
        Surface(
            onClick = { Feed.markRead(store, n.id); onOpen(n) },
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surfaceContainer.let { if (n.read) it else accent.copy(alpha = 0.10f).compositeOver(it) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                if (n.kind == "update") {
                    Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(11.dp)), contentAlignment = Alignment.Center) {
                        ZendrLogo(30.dp)
                    }
                } else {
                    AppBadge(n.app)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            n.title, fontSize = 15.sp, fontWeight = if (n.read) FontWeight.Medium else FontWeight.SemiBold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                        )
                        if (!n.read) {
                            Spacer(Modifier.width(6.dp))
                            Box(Modifier.size(8.dp).background(accent, CircleShape))
                        }
                    }
                    Text(n.text, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.width(8.dp))
                Text(ago(n.at), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private fun ago(at: Long): String {
    val now = System.currentTimeMillis()
    return if (now - at < DateUtils.MINUTE_IN_MILLIS) "Just now"
    else DateUtils.getRelativeTimeSpanString(at, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE).toString()
}

/** Today, Yesterday or Earlier. */
private fun day(at: Long): String {
    val start = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis
    return when {
        at >= start -> "Today"
        at >= start - DateUtils.DAY_IN_MILLIS -> "Yesterday"
        else -> "Earlier"
    }
}

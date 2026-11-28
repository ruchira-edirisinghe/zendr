package dev.zendr.companion

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

sealed class Screen {
    data object Home : Screen()
    data object Pair : Screen()
    data class Sessions(val computer: String) : Screen()
    data class Terminal(
        val computer: String,
        val terminal: String,
        val title: String,
        val app: String? = null,
        val status: String? = null,
    ) : Screen()
    data class About(val from: Screen) : Screen()
    data class Notifications(val from: Screen) : Screen()
}

class MainActivity : ComponentActivity() {
    private var screen by mutableStateOf<Screen>(Screen.Home)
    private var pendingLink by mutableStateOf<String?>(null)
    private var pendingUpdate by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // One computer paired: straight to its sessions (back still shows the computers).
        if (savedInstanceState == null) {
            Store(this).computers().singleOrNull()?.let { screen = Screen.Sessions(it.id) }
        }
        handle(intent)
        Appearance.load(Store(this))
        setContent {
            // The status and navigation bars' icons follow light or dark, as the app does.
            val dark = isDark()
            LaunchedEffect(dark) {
                enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT) { dark },
                    navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { dark },
                )
            }
            ZendrTheme { App() }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    // A pairing link (zendr://pair?...) or a tapped alert (which terminal on which computer).
    private fun handle(intent: Intent?) {
        intent ?: return
        intent.data?.toString()?.takeIf { it.startsWith("zendr://") }?.let { pendingLink = it; screen = Screen.Pair }
        if (intent.getBooleanExtra(EXTRA_UPDATE, false)) pendingUpdate = true
        val c = intent.getStringExtra(EXTRA_COMPUTER)
        val t = intent.getStringExtra(EXTRA_TERMINAL)
        if (c != null && t != null) {
            screen = Screen.Terminal(c, t, intent.getStringExtra(EXTRA_TITLE) ?: "Session", intent.getStringExtra(EXTRA_APP), intent.getStringExtra(EXTRA_STATUS))
        }
    }

    @Composable
    private fun App() {
        val store = remember { Store(this) }
        val about = { screen = Screen.About(screen) }
        val bell = { screen = Screen.Notifications(screen) }
        when (val s = screen) {
            Screen.Home -> HomeScreen(store, onOpen = { screen = Screen.Sessions(it.id) }, onAdd = { screen = Screen.Pair }, onAbout = about, onBell = bell)
            Screen.Pair -> {
                BackHandler { screen = Screen.Home }
                PairScreen(store, pendingLink, onDone = { pendingLink = null; screen = if (it != null) Screen.Sessions(it.id) else Screen.Home })
            }
            is Screen.Sessions -> {
                BackHandler { screen = Screen.Home }
                SessionsScreen(store, s.computer, onBack = { screen = Screen.Home }, onAbout = about, onBell = bell, onOpen = {
                    screen = Screen.Terminal(s.computer, it.terminal, it.title, it.app, it.status)
                })
            }
            is Screen.Terminal -> {
                BackHandler { screen = Screen.Sessions(s.computer) }
                TerminalScreen(store, s, onBack = { screen = Screen.Sessions(s.computer) })
            }
            is Screen.About -> {
                BackHandler { screen = s.from }
                AboutScreen(store, onBack = { screen = s.from })
            }
            is Screen.Notifications -> {
                BackHandler { screen = s.from }
                NotificationsScreen(store, onBack = { screen = s.from }, onOpen = { n ->
                    val c = store.computers().firstOrNull { it.id == n.computer }
                    when {
                        n.kind == "update" -> Updates.latest?.let { Updates.offer = it } ?: run { pendingUpdate = true }
                        c != null && n.terminal != null -> screen = Screen.Terminal(c.id, n.terminal, n.session ?: "Session", n.app)
                        c != null -> screen = Screen.Sessions(c.id)
                    }
                })
            }
        }

        // From the "new version" notification: look now, and offer it.
        LaunchedEffect(pendingUpdate) {
            if (pendingUpdate) {
                pendingUpdate = false
                Updates.check(this@MainActivity, store, manual = true)
            }
        }

        // A new version: offered in a popup when the app opens, and every few hours while it's open.
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(Unit) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (true) {
                    Updates.checkNow(this@MainActivity, store)
                    delay(15 * 60 * 1000L)
                }
            }
        }
        Updates.offer?.let { r ->
            UpdateDialog(
                r, Updates.installed(this),
                onSkip = { store.skipVersion = r.version; Updates.offer = null },
                onClose = { Updates.offer = null },
            )
        }
    }

    companion object {
        const val EXTRA_COMPUTER = "computer"
        const val EXTRA_TERMINAL = "terminal"
        const val EXTRA_TITLE = "title"
        const val EXTRA_APP = "app"
        const val EXTRA_STATUS = "status"
        const val EXTRA_UPDATE = "update"

        // What enableEdgeToEdge() puts behind three-button navigation.
        private val LIGHT_SCRIM = android.graphics.Color.argb(0xe6, 0xFF, 0xFF, 0xFF)
        private val DARK_SCRIM = android.graphics.Color.argb(0x80, 0x1b, 0x1b, 0x1b)
    }
}

/** A line about a computer's sessions: who needs you first. */
private fun summarize(spaces: List<Space>): String {
    val sessions = spaces.flatMap { it.sessions }
    val need = sessions.count { it.status == "blocked" }
    val busy = sessions.count { it.status == "working" }
    return when {
        need > 0 -> "$need need${if (need == 1) "s" else ""} you" + if (busy > 0) " · $busy working" else ""
        busy > 0 -> "$busy working"
        sessions.isEmpty() -> "Nothing running"
        else -> "${sessions.size} session${if (sessions.size == 1) "" else "s"}, all quiet"
    }
}

// ---------------------------------------------------------------- Home: the paired computers

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(store: Store, onOpen: (Computer) -> Unit, onAdd: () -> Unit, onAbout: () -> Unit, onBell: () -> Unit) {
    val context = LocalContext.current
    var computers by remember { mutableStateOf(store.computers()) }
    var summary by remember { mutableStateOf<Map<String, Pair<String, Boolean>>>(emptyMap()) }
    var alerts by remember { mutableStateOf(store.alerts) }
    var forget by remember { mutableStateOf<Computer?>(null) }
    val notifyPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(computers) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                summary = computers.associate { c ->
                    c.id to runCatching { Api.state(store, c).also { Feed.observe(store, c, it) }.let(::summarize) to true }
                        .getOrElse { "Offline: ${it.message}" to false }
                }
                delay(5000)
            }
        }
    }

    Scaffold(
        topBar = {
            ZendrTopBar(
                navigationIcon = { ThemeButton(store) },
                actions = {
                    BellButton(store, onBell)
                    IconButton(onClick = onAbout) { Icon(Icons.Default.Info, "About") }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = onAdd, icon = { Icon(Icons.Default.Add, null) }, text = { Text("Add computer") })
        },
    ) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Notifications, null, tint = if (alerts) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text("Alert me", fontWeight = FontWeight.Medium, fontSize = 16.sp)
                            Text("A notification when an agent needs you or finishes, even with the app closed.",
                                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Spacer(Modifier.width(8.dp))
                        Switch(checked = alerts, onCheckedChange = { on ->
                            alerts = on
                            store.alerts = on
                            if (on) {
                                if (Build.VERSION.SDK_INT >= 33) notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                                WatchService.start(context)
                            } else {
                                WatchService.stop(context)
                            }
                        })
                    }
                }
            }
            if (computers.isEmpty()) {
                item {
                    Column(Modifier.fillMaxWidth().padding(top = 40.dp, start = 8.dp, end = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("No computers yet", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "On your computer, open Zendr, then Settings → Phone → Show pairing code. Then tap Add computer here and scan it.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp,
                        )
                    }
                }
            } else {
                item { Text("Your computers", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, start = 4.dp)) }
            }
            items(computers, key = { it.id }) { c ->
                val (line, online) = summary[c.id] ?: ("Checking…" to true)
                Surface(onClick = { onOpen(c) }, shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(start = 16.dp, top = 14.dp, bottom = 14.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(44.dp).background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
                            Text("💻", fontSize = 22.sp)
                            Box(
                                Modifier.align(Alignment.BottomEnd).padding(2.dp).size(10.dp)
                                    .background(if (online) Green else MaterialTheme.colorScheme.onSurfaceVariant, CircleShape),
                            )
                        }
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(c.name, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(line, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                color = if (line.contains("need")) Red else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        IconButton(onClick = { forget = c }) { Icon(Icons.Default.Delete, "Forget ${c.name}", tint = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
            item { Spacer(Modifier.height(80.dp)) }
        }
    }

    forget?.let { c ->
        AlertDialog(
            onDismissRequest = { forget = null },
            title = { Text("Forget ${c.name}?") },
            text = { Text("This phone stops reaching it. You can scan its code again any time.") },
            confirmButton = { TextButton(onClick = { store.remove(c.id); computers = store.computers(); forget = null }) { Text("Forget") } },
            dismissButton = { TextButton(onClick = { forget = null }) { Text("Cancel") } },
        )
    }
}

// ---------------------------------------------------------------- Pair: scan or paste the code

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairScreen(store: Store, link: String?, onDone: (Computer?) -> Unit) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf(link.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun pair(raw: String) {
        val c = Computer.fromLink(raw)
        if (c == null) {
            error = "That isn't a Zendr pairing code. It starts with zendr://pair"
            return
        }
        busy = true
        error = null
        scope.launch {
            try {
                val hello = Api.hello(null, c)
                val saved = store.add(c.copy(name = hello.optString("name").ifEmpty { c.name }))
                onDone(saved)
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    val scan = rememberLauncherForActivityResult(ScanContract()) { r -> r.contents?.let { text = it; pair(it) } }
    LaunchedEffect(link) { if (!link.isNullOrEmpty()) pair(link) }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Add a computer") },
            navigationIcon = { IconButton(onClick = { onDone(null) }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        )
    }) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).padding(20.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Step(1, "On the computer, install Tailscale and sign in. Do the same on this phone, with the same account.")
            Step(2, "In Zendr on the computer, open Settings → Phone and click Show pairing code.")
            Step(3, "Scan the code. The 6-letter code under it should match the one on the computer.")
            Button(
                onClick = { scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the code in Zendr → Settings → Phone").setBeepEnabled(false).setOrientationLocked(false)) },
                enabled = !busy, modifier = Modifier.fillMaxWidth().height(56.dp), shape = RoundedCornerShape(16.dp),
            ) { Text(if (busy) "Connecting…" else "Scan the code", fontSize = 16.sp) }
            error?.let {
                Surface(color = Red.copy(alpha = 0.12f), shape = RoundedCornerShape(12.dp)) {
                    Text(it, color = Red, fontSize = 14.sp, modifier = Modifier.padding(12.dp))
                }
            }
            Text("Or paste the pairing link (Copy link, on the computer):", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text("zendr://pair?…") }, modifier = Modifier.fillMaxWidth(), minLines = 2, shape = RoundedCornerShape(12.dp))
            OutlinedButton(onClick = { pair(text) }, enabled = !busy && text.isNotBlank(), modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(16.dp)) { Text("Pair") }
        }
    }
}

@Composable
private fun Step(n: Int, text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.size(28.dp).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f), CircleShape), contentAlignment = Alignment.Center) {
            Text("$n", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, fontSize = 14.sp)
        }
        Spacer(Modifier.width(12.dp))
        Text(text, fontSize = 15.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 3.dp))
    }
}

// ---------------------------------------------------------------- Sessions on one computer

private enum class Filter(val label: String) { All("All"), Need("Needs you"), Working("Working"), Done("Done") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(store: Store, computerId: String, onBack: () -> Unit, onAbout: () -> Unit, onBell: () -> Unit, onOpen: (Session) -> Unit) {
    val scope = rememberCoroutineScope()
    val computer = store.computers().firstOrNull { it.id == computerId }
    var spaces by remember { mutableStateOf<List<Space>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf(Filter.All) }
    var tick by remember { mutableIntStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    suspend fun load() {
        val c = store.computers().firstOrNull { it.id == computerId } ?: return
        runCatching { Api.state(store, c) }
            .onSuccess { spaces = it; error = null; Feed.observe(store, c, it) }
            .onFailure { error = it.message }
    }

    LaunchedEffect(computerId, tick) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (computer != null) {
                load()
                delay(2500)
            }
        }
    }

    val all = spaces?.flatMap { it.sessions }.orEmpty()
    val counts = mapOf(
        Filter.All to all.size,
        Filter.Need to all.count { it.status == "blocked" },
        Filter.Working to all.count { it.status == "working" },
        Filter.Done to all.count { it.status == "done" },
    )
    fun keep(s: Session) = when (filter) {
        Filter.All -> true
        Filter.Need -> s.status == "blocked"
        Filter.Working -> s.status == "working"
        Filter.Done -> s.status == "done"
    }

    Scaffold(topBar = {
        ZendrTopBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            actions = {
                BellButton(store, onBell)
                IconButton(onClick = onAbout) { Icon(Icons.Default.Info, "About") }
            },
        )
    }) { pad ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } },
            modifier = Modifier.fillMaxSize().padding(pad),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                // Which computer, and who needs you there.
                item {
                    Column(Modifier.padding(start = 4.dp, top = 2.dp, bottom = 2.dp)) {
                        Text(computer?.name ?: "Computer", fontSize = 22.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            spaces?.let { summarize(it) } ?: if (error != null) "Not reachable right now" else "Connecting…",
                            fontSize = 13.sp, color = if ((counts[Filter.Need] ?: 0) > 0) Red else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (all.isNotEmpty()) {
                    item {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 4.dp)) {
                            items(Filter.entries.filter { it == Filter.All || (counts[it] ?: 0) > 0 }) { f ->
                                FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text("${f.label} ${counts[f] ?: 0}") })
                            }
                        }
                    }
                }
                error?.let { e ->
                    item {
                        Surface(color = Red.copy(alpha = 0.12f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp)) {
                                Text("Can't reach ${computer?.name ?: "it"}", color = Red, fontWeight = FontWeight.SemiBold)
                                Text(e, color = Red, fontSize = 13.sp)
                                TextButton(onClick = { tick++ }) { Text("Try again") }
                            }
                        }
                    }
                }
                spaces?.let { list ->
                    // Whoever needs you first, then the rest by space.
                    val waiting = all.filter { it.status == "blocked" }
                    if (waiting.isNotEmpty() && filter == Filter.All) {
                        item { SectionHeader("Needs you", color = Red) }
                        items(waiting, key = { "w-" + it.terminal }) { SessionRow(it, onOpen) }
                    }
                    list.forEach { space ->
                        val shown = space.sessions.filter(::keep)
                        if (shown.isEmpty()) return@forEach
                        item(key = "h-" + space.id) { SpaceHeader(space.name, shown.size) }
                        items(shown, key = { space.id + it.terminal }) { SessionRow(it, onOpen) }
                    }
                    if (all.isEmpty()) {
                        item {
                            Column(Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("Nothing running there right now", fontSize = 16.sp, fontWeight = FontWeight.Medium)
                                Text("Start an agent in Zendr on the computer and it shows up here.", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(text, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = color, modifier = Modifier.padding(top = 12.dp, start = 4.dp, bottom = 2.dp))
}

@Composable
private fun SpaceHeader(name: String, count: Int) {
    Row(Modifier.padding(top = 14.dp, start = 4.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        SpaceAvatar(name)
        Spacer(Modifier.width(8.dp))
        Text(name, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(6.dp))
        Text("$count", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SessionRow(s: Session, onOpen: (Session) -> Unit) {
    val needs = s.status == "blocked"
    Surface(
        onClick = { onOpen(s) },
        shape = RoundedCornerShape(14.dp),
        color = if (needs) Red.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth().heightIn(min = 68.dp),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            AppBadge(s.app)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(s.title, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (s.tab.isNotEmpty() && !s.tab.all(Char::isDigit)) "${s.tab} · ${s.terminal}" else s.terminal,
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(8.dp))
            StatusChip(s.status)
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

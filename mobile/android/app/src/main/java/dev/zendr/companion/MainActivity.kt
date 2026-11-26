package dev.zendr.companion

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

sealed class Screen {
    data object Home : Screen()
    data object Pair : Screen()
    data class Sessions(val computer: String) : Screen()
    data class Terminal(val computer: String, val terminal: String, val title: String) : Screen()
}

class MainActivity : ComponentActivity() {
    private var screen by mutableStateOf<Screen>(Screen.Home)
    private var pendingLink by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        setContent { ZendrTheme { App() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    // A pairing link (zendr://pair?...) or a tapped alert (which terminal on which computer).
    private fun handle(intent: Intent?) {
        intent ?: return
        intent.data?.toString()?.takeIf { it.startsWith("zendr://") }?.let { pendingLink = it; screen = Screen.Pair }
        val c = intent.getStringExtra(EXTRA_COMPUTER)
        val t = intent.getStringExtra(EXTRA_TERMINAL)
        if (c != null && t != null) screen = Screen.Terminal(c, t, "Session")
    }

    @Composable
    private fun App() {
        val store = remember { Store(this) }
        when (val s = screen) {
            Screen.Home -> HomeScreen(store, onOpen = { screen = Screen.Sessions(it.id) }, onAdd = { screen = Screen.Pair })
            Screen.Pair -> {
                BackHandler { screen = Screen.Home }
                PairScreen(store, pendingLink, onDone = { pendingLink = null; screen = if (it != null) Screen.Sessions(it.id) else Screen.Home })
            }
            is Screen.Sessions -> {
                BackHandler { screen = Screen.Home }
                SessionsScreen(store, s.computer, onBack = { screen = Screen.Home }, onOpen = { screen = Screen.Terminal(s.computer, it.terminal, it.title) })
            }
            is Screen.Terminal -> {
                BackHandler { screen = Screen.Sessions(s.computer) }
                TerminalScreen(store, s, onBack = { screen = Screen.Sessions(s.computer) })
            }
        }
    }

    companion object {
        const val EXTRA_COMPUTER = "computer"
        const val EXTRA_TERMINAL = "terminal"
    }
}

private val Green = Color(0xFF2FBF71)
private val Red = Color(0xFFE5534B)
private val Amber = Color(0xFFE0A030)

@Composable
fun ZendrTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val scheme = if (dark) {
        darkColorScheme(
            primary = Green, onPrimary = Color(0xFF06210F), background = Color(0xFF15171A), surface = Color(0xFF15171A),
            surfaceVariant = Color(0xFF22252A), onSurfaceVariant = Color(0xFFB7BCC4),
        )
    } else {
        lightColorScheme(primary = Color(0xFF1E8A50), onPrimary = Color.White, surfaceVariant = Color(0xFFEDEFF2))
    }
    MaterialTheme(colorScheme = scheme) { Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() } }
}

@Composable
fun StatusChip(status: String?) {
    val color = when (status) {
        "blocked" -> Red
        "working" -> Amber
        "done" -> Green
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        Modifier.background(color.copy(alpha = 0.16f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(statusLabel(status), color = color, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}

// ---------------------------------------------------------------- Home: the paired computers

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(store: Store, onOpen: (Computer) -> Unit, onAdd: () -> Unit) {
    val context = LocalContext.current
    var computers by remember { mutableStateOf(store.computers()) }
    var summary by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var alerts by remember { mutableStateOf(store.alerts) }
    var forget by remember { mutableStateOf<Computer?>(null) }
    val notifyPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

    LaunchedEffect(computers) {
        while (true) {
            summary = computers.associate { c ->
                c.id to runCatching {
                    val sessions = Api.state(store, c).flatMap { it.sessions }
                    val need = sessions.count { it.status == "blocked" }
                    val busy = sessions.count { it.status == "working" }
                    when {
                        need > 0 -> "$need need${if (need == 1) "s" else ""} you"
                        busy > 0 -> "$busy working"
                        else -> "${sessions.size} session${if (sessions.size == 1) "" else "s"}, all quiet"
                    }
                }.getOrElse { "Offline: ${it.message}" }
            }
            delay(5000)
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Zendr", fontWeight = FontWeight.SemiBold) }) },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = onAdd, icon = { Icon(Icons.Default.Add, null) }, text = { Text("Add computer") })
        },
    ) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Alert me", fontWeight = FontWeight.Medium)
                            Text("A notification when an agent needs you or finishes, even with the app closed.",
                                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
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
                    Column(Modifier.fillMaxWidth().padding(top = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("No computers yet", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "On your computer, open Zendr, then Settings → Phone, and scan the code it shows with Add computer.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp,
                        )
                    }
                }
            }
            items(computers, key = { it.id }) { c ->
                Card(
                    Modifier.fillMaxWidth().clickable { onOpen(c) },
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Home, null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(c.name, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                            val line = summary[c.id] ?: "Checking…"
                            Text(line, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                color = if (line.contains("need")) Red else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        IconButton(onClick = { forget = c }) { Icon(Icons.Default.Delete, "Forget ${c.name}") }
                    }
                }
            }
            item { Spacer(Modifier.height(72.dp)) }
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
        Column(Modifier.fillMaxSize().padding(pad).padding(20.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Step(1, "On the computer, install Tailscale and sign in. Do the same on this phone, with the same account.")
            Step(2, "In Zendr on the computer, open Settings → Phone and click Show pairing code.")
            Step(3, "Scan the code below. The 6-letter code under it should match the one on the computer.")
            Button(
                onClick = { scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the code in Zendr → Settings → Phone").setBeepEnabled(false).setOrientationLocked(false)) },
                enabled = !busy, modifier = Modifier.fillMaxWidth().height(52.dp),
            ) { Text(if (busy) "Connecting…" else "Scan the code") }
            Text("Or paste the pairing link (Copy link, on the computer):", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text("zendr://pair?…") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            OutlinedButton(onClick = { pair(text) }, enabled = !busy && text.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Pair") }
            error?.let { Text(it, color = Red, fontSize = 14.sp) }
        }
    }
}

@Composable
private fun Step(n: Int, text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.size(26.dp).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f), CircleShape), contentAlignment = Alignment.Center) {
            Text("$n", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, fontSize = 13.sp)
        }
        Spacer(Modifier.width(12.dp))
        Text(text, fontSize = 15.sp, modifier = Modifier.padding(top = 3.dp))
    }
}

// ---------------------------------------------------------------- Sessions on one computer

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(store: Store, computerId: String, onBack: () -> Unit, onOpen: (Session) -> Unit) {
    val computer = store.computers().firstOrNull { it.id == computerId }
    var spaces by remember { mutableStateOf<List<Space>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(computerId) {
        while (computer != null) {
            runCatching { Api.state(store, store.computers().first { it.id == computerId }) }
                .onSuccess { spaces = it; error = null }
                .onFailure { error = it.message }
            delay(3000)
        }
    }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text(computer?.name ?: "Computer") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        )
    }) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            error?.let { item { Text(it, color = Red, fontSize = 14.sp) } }
            if (spaces == null && error == null) item { Text("Connecting…", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            spaces?.let { list ->
                // Whoever needs you first, then the rest by space.
                val waiting = list.flatMap { it.sessions }.filter { it.status == "blocked" }
                if (waiting.isNotEmpty()) {
                    item { Header("Needs you") }
                    items(waiting, key = { "w-" + it.terminal }) { SessionRow(it) { onOpen(it) } }
                }
                list.filter { it.sessions.isNotEmpty() }.forEach { space ->
                    item(key = "h-" + space.id) { Header(space.name) }
                    items(space.sessions, key = { space.id + it.terminal }) { SessionRow(it) { onOpen(it) } }
                }
                if (list.all { it.sessions.isEmpty() }) item { Text("Nothing running there right now.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

@Composable
private fun Header(text: String) {
    Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 12.dp, bottom = 2.dp))
}

@Composable
private fun SessionRow(s: Session, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(s.title, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (s.tab.isNotEmpty() && !s.tab.all(Char::isDigit)) "${s.tab} · ${s.terminal}" else s.terminal,
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            StatusChip(s.status)
        }
    }
}

// ---------------------------------------------------------------- One terminal: read and answer

private val QUICK_KEYS = listOf("1" to "1", "2" to "2", "3" to "3", "Enter" to "enter", "Esc" to "esc",
    "↑" to "up", "↓" to "down", "Tab" to "tab", "Ctrl+C" to "ctrl+c")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(store: Store, s: Screen.Terminal, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var screenText by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var input by remember { mutableStateOf("") }
    val vScroll = rememberScrollState()
    val hScroll = rememberScrollState()
    fun computer() = store.computers().firstOrNull { it.id == s.computer }

    LaunchedEffect(s.terminal) {
        while (true) {
            val c = computer() ?: break
            runCatching { Api.read(store, c, s.terminal) }
                .onSuccess { if (it != screenText) { screenText = it.trimEnd() } ; error = null }
                .onFailure { error = it.message }
            delay(2000)
        }
    }
    LaunchedEffect(screenText) { vScroll.scrollTo(vScroll.maxValue) }

    fun act(block: suspend (Computer) -> Unit) {
        val c = computer() ?: return
        scope.launch {
            runCatching { block(c) }.onFailure { snack.showSnackbar(it.message ?: "That didn't work") }
            runCatching { screenText = Api.read(store, c, s.terminal).trimEnd() }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(s.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = { TextButton(onClick = { act { Api.focus(store, it, s.terminal) } }) { Text("Show on PC") } },
            )
        },
        snackbarHost = { SnackbarHost(snack) },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).imePadding()) {
            error?.let { Text(it, color = Red, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) }
            Box(
                Modifier.weight(1f).fillMaxWidth().padding(horizontal = 8.dp)
                    .background(Color(0xFF0E1013), RoundedCornerShape(10.dp))
                    .verticalScroll(vScroll).horizontalScroll(hScroll).padding(10.dp),
            ) {
                Text(screenText.ifEmpty { "…" }, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Color(0xFFD7DAE0), softWrap = false)
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                QUICK_KEYS.forEach { (label, key) ->
                    AssistChip(onClick = { act { Api.keys(store, it, s.terminal, listOf(key)) } }, label = { Text(label) })
                }
            }
            Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = input, onValueChange = { input = it }, modifier = Modifier.weight(1f),
                    placeholder = { Text("Reply…") }, maxLines = 4,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        val t = input.trim(); if (t.isNotEmpty()) { input = ""; act { Api.send(store, it, s.terminal, t) } }
                    }),
                )
                IconButton(onClick = {
                    val t = input.trim(); if (t.isNotEmpty()) { input = ""; act { Api.send(store, it, s.terminal, t) } }
                }) { Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = MaterialTheme.colorScheme.primary) }
            }
        }
    }
}

package dev.zendr.companion

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The keys along the bottom, as on a keyboard: what each says and what it presses. */
private val KEYS = listOf(
    Triple("Esc", "esc", "Escape"), Triple("Tab", "tab", "Tab"),
    Triple("↑", "up", "Up"), Triple("↓", "down", "Down"), Triple("←", "left", "Left"), Triple("→", "right", "Right"),
    Triple("⏎", "enter", "Enter"), Triple("^C", "ctrl+c", "Control C"),
)

private const val MIN_TEXT = 5f
private const val MAX_TEXT = 22f

/** One session on one computer: its screen, kept up to date, and ways to answer it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(store: Store, s: Screen.Terminal, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    val clipboard = LocalClipboardManager.current
    var screen by remember { mutableStateOf<ScreenText?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf(s.status) }
    var input by remember { mutableStateOf(TextFieldValue("")) }
    var suggestions by remember { mutableStateOf<List<String>>(emptyList()) }
    var textSize by remember { mutableFloatStateOf(store.textSize) }
    // The size that fits the computer's terminal to this screen's width (set as it's measured).
    var fitSize by remember { mutableFloatStateOf(11f) }
    var wrap by remember { mutableStateOf(store.wrap) }
    var menu by remember { mutableStateOf(false) }
    var refreshNow by remember { mutableStateOf(0) }
    val list = rememberLazyListState()
    fun computer() = store.computers().firstOrNull { it.id == s.computer }
    val computerName = remember { computer()?.name.orEmpty() }

    // The screen stays on while you watch an agent work.
    val view = LocalView.current
    DisposableEffect(Unit) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }

    // Read the screen about once a second while the app is in front, and the session's state
    // now and then; at once after you press or send something.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(s.terminal, refreshNow) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            var n = 0
            while (true) {
                val c = computer() ?: break
                runCatching { Api.screen(store, c, s.terminal) }
                    .onSuccess { if (it != screen) screen = it; error = null }
                    .onFailure { error = it.message }
                if (n++ % 4 == 0) {
                    runCatching { Api.state(store, c) }.onSuccess { spaces ->
                        spaces.flatMap { it.sessions }.firstOrNull { it.terminal == s.terminal }?.let { status = it.status }
                    }
                }
                delay(1200)
            }
        }
    }

    val palette = screen?.palette ?: Palette.Default
    val lines: List<AnnotatedString> = remember(screen) {
        val sc = screen ?: return@remember emptyList()
        val all = if (sc.styled) Ansi.lines(sc.text, palette) else sc.text.replace("\r\n", "\n").split('\n').map { AnnotatedString(it) }
        all.dropLastWhile { it.text.isBlank() }
    }
    val plain = remember(lines) { lines.joinToString("\n") { it.text } }
    val choices = remember(plain, status) { if (status == "blocked") Choices.find(plain) else emptyList() }

    // Shells get suggestions from the computer's command history, as on the computer.
    val shell = s.app == null
    LaunchedEffect(input.text) {
        val c = computer()
        if (!shell || c == null || input.text.isBlank()) {
            suggestions = emptyList()
            return@LaunchedEffect
        }
        delay(180)
        suggestions = Api.suggest(store, c, input.text)
    }
    val ghost = suggestions.firstOrNull()
        ?.takeIf { input.selection.collapsed && input.selection.end == input.text.length }
        ?.removePrefix(input.text).orEmpty()

    fun act(block: suspend (Computer) -> Unit) {
        val c = computer() ?: return
        scope.launch {
            runCatching { block(c) }.onFailure { snack.showSnackbar(it.message ?: "That didn't work") }
            runCatching { Api.screen(store, c, s.terminal) }.onSuccess { screen = it }
        }
    }

    fun press(key: String) = act { Api.keys(store, it, s.terminal, listOf(key)) }

    fun sendInput() {
        val t = input.text.trim()
        input = TextFieldValue("")
        suggestions = emptyList()
        // Nothing typed: Enter on its own.
        if (t.isEmpty()) press("enter") else act { Api.send(store, it, s.terminal, t, force = true) }
    }

    fun acceptSuggestion() {
        val full = input.text + ghost
        input = TextFieldValue(full, TextRange(full.length))
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(s.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StatusChip(status, compact = true)
                            if (computerName.isNotEmpty()) {
                                Spacer(Modifier.width(8.dp))
                                Text(computerName, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Show on the computer") }, onClick = { menu = false; act { Api.focus(store, it, s.terminal) } })
                        DropdownMenuItem(text = { Text("Copy the screen") }, onClick = {
                            menu = false
                            clipboard.setText(AnnotatedString(plain))
                            scope.launch { snack.showSnackbar("Copied") }
                        })
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text("Wrap long lines") },
                            trailingIcon = { if (wrap) Icon(Icons.Default.Check, null) },
                            onClick = { wrap = !wrap; store.wrap = wrap; menu = false },
                        )
                        DropdownMenuItem(
                            text = { Text("Fit to the screen's width") },
                            trailingIcon = { if (textSize == 0f) Icon(Icons.Default.Check, null) },
                            onClick = { textSize = 0f; store.textSize = 0f; menu = false },
                        )
                        DropdownMenuItem(text = { Text("Bigger text") }, onClick = { textSize = ((if (textSize == 0f) fitSize else textSize) + 1f).coerceAtMost(MAX_TEXT); store.textSize = textSize })
                        DropdownMenuItem(text = { Text("Smaller text") }, onClick = { textSize = ((if (textSize == 0f) fitSize else textSize) - 1f).coerceAtLeast(MIN_TEXT); store.textSize = textSize })
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snack) },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).consumeWindowInsets(pad).imePadding()) {
            // ------------------------------------------------ the screen
            BoxWithConstraints(
                Modifier.weight(1f).fillMaxWidth().padding(horizontal = 6.dp)
                    .background(palette.bg, RoundedCornerShape(12.dp))
                    .pinchToZoom { zoom ->
                        val from = if (textSize == 0f) fitSize else textSize
                        textSize = (from * zoom).coerceIn(MIN_TEXT, MAX_TEXT)
                        store.textSize = textSize
                    },
            ) {
                val density = LocalDensity.current
                val measurer = rememberTextMeasurer()
                // One monospace character's width in px at 10sp.
                val charAt10 = remember(measurer, density) {
                    measurer.measure("0000000000", TextStyle(fontFamily = FontFamily.Monospace, fontSize = 10.sp)).size.width / 10f
                }
                val padPx = with(density) { 10.dp.toPx() }
                val room = (constraints.maxWidth - 2 * padPx).coerceAtLeast(1f)
                val cols = screen?.cols?.takeIf { it > 0 } ?: lines.maxOfOrNull { it.length }?.coerceIn(40, 400) ?: 80
                val fit = (10f * room / (cols * charAt10)).coerceIn(MIN_TEXT, 16f)
                SideEffect { fitSize = fit }
                val size = if (textSize == 0f) fit else textSize
                val lineWidthPx = maxOf(room, cols * charAt10 * size / 10f)
                val style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = size.sp, lineHeight = (size * 1.22f).sp, color = palette.fg)
                val atBottom by remember { derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 24 } }
                val hScroll = rememberScrollState()

                when {
                    screen == null && error != null -> Column(
                        Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text("Can't reach $computerName", color = palette.fg, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                        Spacer(Modifier.height(6.dp))
                        Text(error.orEmpty(), color = palette.fg.copy(alpha = 0.7f), fontSize = 13.sp)
                        Spacer(Modifier.height(14.dp))
                        FilledTonalButton(onClick = { refreshNow++ }) { Text("Try again") }
                    }
                    screen == null -> Text("Connecting…", color = palette.fg.copy(alpha = 0.7f), modifier = Modifier.align(Alignment.Center))
                    else -> SelectionContainer {
                        Box(if (wrap) Modifier.fillMaxSize() else Modifier.fillMaxSize().horizontalScroll(hScroll)) {
                            // Newest at the bottom, and kept there while you're there.
                            LazyColumn(
                                state = list,
                                reverseLayout = true,
                                contentPadding = PaddingValues(10.dp),
                                modifier = (if (wrap) Modifier.fillMaxWidth() else Modifier.width(with(density) { (lineWidthPx + 2 * padPx).toDp() })).fillMaxHeight(),
                            ) {
                                items(lines.asReversed()) { line ->
                                    Text(line.ifEmpty { AnnotatedString(" ") }, style = style, softWrap = wrap, maxLines = if (wrap) Int.MAX_VALUE else 1)
                                }
                            }
                        }
                    }
                }
                androidx.compose.animation.AnimatedVisibility(!atBottom && screen != null, modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp)) {
                    SmallFloatingActionButton(onClick = { scope.launch { list.animateScrollToItem(0) } }) {
                        Icon(Icons.Default.KeyboardArrowDown, "Jump to the newest")
                    }
                }
                if (error != null && screen != null) {
                    Text(
                        "Reconnecting… $error", color = Color.White, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.align(Alignment.TopCenter).fillMaxWidth().background(Red.copy(alpha = 0.85f), RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp)).padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
            }

            // ------------------------------------------------ what the agent is asking
            if (choices.isNotEmpty()) {
                Text("Choose an answer", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Red, modifier = Modifier.padding(start = 14.dp, top = 8.dp))
                LazyRow(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(choices, key = { it.key }) { c ->
                        FilledTonalButton(onClick = { press(c.key) }, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp)) {
                            Text(c.key, fontWeight = FontWeight.Bold)
                            Spacer(Modifier.width(8.dp))
                            Text(c.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }

            // ------------------------------------------------ keys
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                KEYS.forEach { (label, key, name) ->
                    Surface(
                        onClick = { press(key) },
                        shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.surfaceContainerHigh,
                        modifier = Modifier.weight(1f).height(44.dp).semantics { contentDescription = name },
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(label, fontSize = if (label.length > 2) 13.sp else 17.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }

            // ------------------------------------------------ suggestions and the reply box
            if (suggestions.isNotEmpty()) {
                LazyRow(contentPadding = PaddingValues(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(suggestions) { cmd ->
                        Surface(
                            onClick = { input = TextFieldValue(cmd, TextRange(cmd.length)) },
                            shape = RoundedCornerShape(50),
                            color = MaterialTheme.colorScheme.secondaryContainer,
                        ) {
                            Text(cmd, fontFamily = FontFamily.Monospace, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                color = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp))
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                val ghostColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                TextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f).onPreviewKeyEvent { e ->
                        // A keyboard's Tab or → takes the suggestion, as on the computer.
                        if (e.type == KeyEventType.KeyDown && ghost.isNotEmpty() && (e.key == Key.Tab || e.key == Key.DirectionRight)) {
                            acceptSuggestion(); true
                        } else false
                    },
                    placeholder = { Text(if (shell) "Type a command…" else "Reply to ${s.title}…") },
                    maxLines = 5,
                    shape = RoundedCornerShape(24.dp),
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                    ),
                    textStyle = TextStyle(fontFamily = if (shell) FontFamily.Monospace else FontFamily.Default, fontSize = 15.sp),
                    visualTransformation = GhostText(ghost, ghostColor),
                    keyboardOptions = KeyboardOptions(
                        imeAction = ImeAction.Send,
                        autoCorrectEnabled = !shell,
                        capitalization = if (shell) KeyboardCapitalization.None else KeyboardCapitalization.Sentences,
                    ),
                    keyboardActions = KeyboardActions(onSend = { sendInput() }),
                    trailingIcon = if (ghost.isNotEmpty()) {
                        { IconButton(onClick = { acceptSuggestion() }) { Text("⇥", fontSize = 18.sp, color = MaterialTheme.colorScheme.primary) } }
                    } else null,
                )
                Spacer(Modifier.width(6.dp))
                FilledIconButton(onClick = { sendInput() }, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Send, "Send")
                }
            }
        }
    }
}

/** The rest of a suggested command after what's typed, in grey (Warp's ghost text). */
private class GhostText(private val ghost: String, private val color: Color) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        if (ghost.isEmpty()) return TransformedText(text, OffsetMapping.Identity)
        val out = buildAnnotatedString {
            append(text)
            withStyle(SpanStyle(color = color)) { append(ghost) }
        }
        val mapping = object : OffsetMapping {
            override fun originalToTransformed(offset: Int) = offset
            override fun transformedToOriginal(offset: Int) = offset.coerceAtMost(text.length)
        }
        return TransformedText(out, mapping)
    }

    override fun equals(other: Any?) = other is GhostText && other.ghost == ghost && other.color == color
    override fun hashCode() = ghost.hashCode() * 31 + color.hashCode()
}

/** Two fingers change the text size; one finger still scrolls. */
private fun Modifier.pinchToZoom(onZoom: (Float) -> Unit): Modifier = pointerInput(Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        do {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            if (event.changes.count { it.pressed } >= 2) {
                val zoom = event.calculateZoom()
                if (zoom != 1f) onZoom(zoom)
                event.changes.forEach { it.consume() }
            }
        } while (event.changes.any { it.pressed })
    }
}

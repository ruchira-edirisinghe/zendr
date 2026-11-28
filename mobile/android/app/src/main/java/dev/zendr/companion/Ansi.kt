package dev.zendr.companion

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import org.json.JSONObject

/** A terminal's colours: its text, its background and the 16 ANSI colours (the computer's theme). */
data class Palette(val fg: Color, val bg: Color, val ansi: List<Color>) {
    companion object {
        /** Zendr's dark theme, for screens that came without colours. */
        val Default = Palette(
            fg = Color(0xFFD7DAE0),
            bg = Color(0xFF0E1013),
            ansi = listOf(
                0xFF1D1F23, 0xFFE5534B, 0xFF57AB5A, 0xFFC69026, 0xFF539BF5, 0xFFB083F0, 0xFF39C5CF, 0xFFADBAC7,
                0xFF636E7B, 0xFFFF938A, 0xFF6BC46D, 0xFFDAAA3F, 0xFF6CB6FF, 0xFFDCBDFB, 0xFF56D4DD, 0xFFCDD9E5,
            ).map { Color(it) },
        )

        fun fromJson(j: JSONObject?): Palette? {
            j ?: return null
            val fg = parseHex(j.optString("fg")) ?: return null
            val bg = parseHex(j.optString("bg")) ?: return null
            val a = j.optJSONArray("ansi") ?: return null
            if (a.length() < 16) return null
            val ansi = (0 until 16).map { parseHex(a.optString(it)) ?: Default.ansi[it] }
            return Palette(fg, bg, ansi)
        }

        fun parseHex(s: String?): Color? {
            val h = s?.trim()?.removePrefix("#") ?: return null
            if (h.length != 6) return null
            val v = h.toLongOrNull(16) ?: return null
            return Color(0xFF000000 or v)
        }
    }

    /** One of the 256 xterm colours. */
    fun color256(n: Int): Color = when {
        n < 16 -> ansi[n]
        n < 232 -> {
            val i = n - 16
            val step = { v: Int -> if (v == 0) 0 else 55 + v * 40 }
            Color(step(i / 36), step((i / 6) % 6), step(i % 6))
        }
        else -> (8 + (n - 232) * 10).let { Color(it, it, it) }
    }
}

/** What SGR (`ESC [ … m`) has set so far. */
private data class Pen(
    val fg: Color? = null,
    val bg: Color? = null,
    val bold: Boolean = false,
    val faint: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val strike: Boolean = false,
    val inverse: Boolean = false,
) {
    fun style(p: Palette): SpanStyle? {
        if (this == Pen()) return null
        var f = fg ?: p.fg
        var b = bg
        if (inverse) {
            b = f
            f = bg ?: p.bg
        }
        if (faint) f = f.copy(alpha = 0.6f)
        val deco = when {
            underline && strike -> TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
            underline -> TextDecoration.Underline
            strike -> TextDecoration.LineThrough
            else -> null
        }
        return SpanStyle(
            color = f,
            background = b ?: Color.Unspecified,
            fontWeight = if (bold) FontWeight.Bold else null,
            fontStyle = if (italic) FontStyle.Italic else null,
            textDecoration = deco,
        )
    }
}

/** Splits a screen into lines and colours each one: what the computer sent with its escapes. */
object Ansi {
    fun lines(text: String, palette: Palette): List<AnnotatedString> {
        var pen = Pen()
        return text.replace("\r\n", "\n").split('\n').map { line ->
            val (styled, after) = line(line, pen, palette)
            pen = after
            styled
        }
    }

    /** Text without any escapes (to copy, and to look for choices in). */
    fun plain(text: String): String = lines(text, Palette.Default).joinToString("\n") { it.text }

    private fun line(s: String, start: Pen, p: Palette): Pair<AnnotatedString, Pen> {
        val out = AnnotatedString.Builder()
        var pen = start
        var i = 0
        var runStart = 0
        fun flush() {
            if (i > runStart) {
                val text = s.substring(runStart, i).replace("\r", "")
                val style = pen.style(p)
                if (style != null) out.withStyle(style) { append(text) } else out.append(text)
            }
        }
        while (i < s.length) {
            val c = s[i]
            if (c != '\u001b') {
                i++
                continue
            }
            flush()
            val next = s.getOrNull(i + 1)
            when (next) {
                '[' -> {
                    // CSI: parameters, then a final letter. Only SGR changes how text looks.
                    var j = i + 2
                    while (j < s.length && s[j] !in '@'..'~') j++
                    if (j < s.length && s[j] == 'm') pen = sgr(s.substring(i + 2, j), pen, p)
                    i = (j + 1).coerceAtMost(s.length)
                }
                ']' -> {
                    // OSC (links, titles): up to BEL or ESC \.
                    var j = i + 2
                    while (j < s.length && s[j] != '\u0007' && !(s[j] == '\u001b' && s.getOrNull(j + 1) == '\\')) j++
                    i = if (j < s.length && s[j] == '\u001b') j + 2 else (j + 1).coerceAtMost(s.length)
                }
                else -> i = (i + 2).coerceAtMost(s.length)
            }
            runStart = i
        }
        flush()
        return out.toAnnotatedString() to pen
    }

    private fun sgr(params: String, start: Pen, p: Palette): Pen {
        // `4:3` (curly underline) and friends: the part before ':' says what it is.
        val codes = if (params.isEmpty()) listOf(0) else params.split(';').map { it.substringBefore(':').toIntOrNull() ?: 0 }
        var pen = start
        var k = 0
        fun extended(): Color? {
            // 38;5;n or 38;2;r;g;b (and the same after 48 for backgrounds)
            return when (codes.getOrNull(k + 1)) {
                5 -> codes.getOrNull(k + 2)?.let { k += 2; p.color256(it.coerceIn(0, 255)) }
                2 -> {
                    val r = codes.getOrNull(k + 2); val g = codes.getOrNull(k + 3); val b = codes.getOrNull(k + 4)
                    k += 4
                    if (r != null && g != null && b != null) Color(r.coerceIn(0, 255), g.coerceIn(0, 255), b.coerceIn(0, 255)) else null
                }
                else -> null
            }
        }
        while (k < codes.size) {
            when (val n = codes[k]) {
                0 -> pen = Pen()
                1 -> pen = pen.copy(bold = true)
                2 -> pen = pen.copy(faint = true)
                3 -> pen = pen.copy(italic = true)
                4, 21 -> pen = pen.copy(underline = true)
                7 -> pen = pen.copy(inverse = true)
                9 -> pen = pen.copy(strike = true)
                22 -> pen = pen.copy(bold = false, faint = false)
                23 -> pen = pen.copy(italic = false)
                24 -> pen = pen.copy(underline = false)
                27 -> pen = pen.copy(inverse = false)
                29 -> pen = pen.copy(strike = false)
                in 30..37 -> pen = pen.copy(fg = p.ansi[n - 30])
                38 -> pen = pen.copy(fg = extended() ?: pen.fg)
                39 -> pen = pen.copy(fg = null)
                in 40..47 -> pen = pen.copy(bg = p.ansi[n - 40])
                48 -> pen = pen.copy(bg = extended() ?: pen.bg)
                49 -> pen = pen.copy(bg = null)
                in 90..97 -> pen = pen.copy(fg = p.ansi[n - 90 + 8])
                in 100..107 -> pen = pen.copy(bg = p.ansi[n - 100 + 8])
            }
            k++
        }
        return pen
    }
}

/** A numbered choice an agent is asking you to pick ("❯ 1. Yes"), and the key that picks it. */
data class Choice(val key: String, val label: String)

object Choices {
    private val OPTION = Regex("""^(?:[❯›>▶➜→*●○◯]\s*)?(\d)[.)]\s+(.+)$""")
    private val EDGES = "│┃|║ \t"

    /**
     * The last list of numbered choices near the bottom of a screen (Claude Code's and Codex's
     * permission prompts): at least two, numbered from 1 in order.
     */
    fun find(plain: String): List<Choice> {
        val lines = plain.trimEnd().lines().takeLast(24)
        var best: List<Choice> = emptyList()
        var run = mutableListOf<Choice>()
        for (raw in lines) {
            val line = raw.trim { it in EDGES }.trim()
            val m = OPTION.matchEntire(line)
            if (m != null) {
                val n = m.groupValues[1]
                val label = m.groupValues[2].trim { it in EDGES }.trim()
                if (n == "1") run = mutableListOf()
                if (n.toInt() == run.size + 1 && label.isNotEmpty()) {
                    run += Choice(n, label.take(48))
                    if (run.size >= 2) best = run.toList()
                    continue
                }
            }
            // A description line under an option keeps the list going; a blank one too.
        }
        return best
    }
}

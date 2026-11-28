package dev.zendr.companion

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnsiTest {
    private val p = Palette.Default

    @Test fun colorsFollowSgrAcrossLinesUntilReset() {
        val lines = Ansi.lines("\u001b[31mred\r\nstill red\u001b[0m plain", p)
        assertEquals(listOf("red", "still red plain"), lines.map { it.text })
        assertEquals(p.ansi[1], lines[0].spanStyles.single().item.color)
        val second = lines[1].spanStyles.single()
        assertEquals(0 to 9, second.start to second.end)
        assertEquals(p.ansi[1], second.item.color)
    }

    @Test fun boldBrightTrueColorAnd256() {
        val l = Ansi.lines("\u001b[1;92mok\u001b[22;38;2;10;20;30mrgb\u001b[38;5;196mx\u001b[48;5;232my", p).single()
        assertEquals("okrgbxy", l.text)
        val s = l.spanStyles
        assertEquals(FontWeight.Bold, s[0].item.fontWeight)
        assertEquals(p.ansi[10], s[0].item.color)
        assertEquals(Color(10, 20, 30), s[1].item.color)
        assertEquals(Color(255, 0, 0), s[2].item.color)
        assertEquals(Color(8, 8, 8), s[3].item.background)
    }

    @Test fun inverseSwapsAndLinksAndOtherEscapesVanish() {
        val l = Ansi.lines("\u001b]8;;https://x.dev\u001b\\link\u001b]8;;\u001b\\ \u001b[7mINV\u001b[27m\u001b[2K\u001b[?25h", p).single()
        assertEquals("link INV", l.text)
        val inv = l.spanStyles.single()
        assertEquals(p.bg, inv.item.color)
        assertEquals(p.fg, inv.item.background)
    }

    @Test fun plainTextHasNoStyles() {
        val l = Ansi.lines("just text", p).single()
        assertEquals("just text", l.text)
        assertTrue(l.spanStyles.isEmpty())
    }

    @Test fun readsTheComputersPalette() {
        val j = JSONObject().put("fg", "#ffffff").put("bg", "#000000").put("ansi", JSONArray((0 until 16).map { "#0000%02x".format(it) }))
        val pal = Palette.fromJson(j)!!
        assertEquals(Color.White, pal.fg)
        assertEquals(Color(0, 0, 5), pal.ansi[5])
        assertNull(Palette.fromJson(JSONObject().put("fg", "#fff")))
    }

    @Test fun findsTheChoicesAnAgentOffers() {
        val claude = """
            ╭──────────────────────────────────────╮
            │ Bash command                         │
            │   npm test                           │
            │ Do you want to proceed?              │
            │ ❯ 1. Yes                             │
            │   2. Yes, and don't ask again        │
            │   3. No, and tell Claude what to do  │
            ╰──────────────────────────────────────╯
        """.trimIndent()
        assertEquals(
            listOf(Choice("1", "Yes"), Choice("2", "Yes, and don't ask again"), Choice("3", "No, and tell Claude what to do")),
            Choices.find(claude),
        )
        assertEquals(listOf("Yes", "No"), Choices.find("Codex wants to run: npm test\n> 1. Yes\n  2. No").map { it.label })
        assertTrue(Choices.find("nothing to choose here\n$ ").isEmpty())
        assertTrue(Choices.find("1. only one").isEmpty())
        // A list that skips a number isn't a menu.
        assertTrue(Choices.find("1. a\n3. c").isEmpty())
    }
}

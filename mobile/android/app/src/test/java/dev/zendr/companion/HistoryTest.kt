package dev.zendr.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HistoryTest {
    private val all = (1..50).map { "line $it" }

    @Test fun earlierLinesAboveWhatsShown() {
        // The phone showed the last 10 lines; a longer read has all 50.
        assertEquals(40, History.earlier(all, all.takeLast(10)))
    }

    @Test fun newOutputAfterwardDoesNotMoveIt() {
        val shown = all.subList(30, 40)
        val later = all + listOf("new 1", "new 2", "new 3")
        assertEquals(30, History.earlier(later, shown))
    }

    @Test fun blankLinesOnTopAreSkippedWhenMatching() {
        val withGap = listOf("a", "", "", "b", "c", "d", "e")
        assertEquals(1, History.earlier(withGap, listOf("", "", "b", "c", "d", "e")))
    }

    @Test fun repeatedLinesMatchTheRightPlace() {
        val repeated = listOf("x", "y", "x", "y", "z")
        assertEquals(2, History.earlier(repeated, listOf("x", "y", "z")))
    }

    @Test fun trailingSpacesDoNotMatter() {
        assertEquals(1, History.earlier(listOf("a", "b  ", "c"), listOf("b", "c")))
    }

    @Test fun nothingWhenTheShownLinesAreGone() {
        assertNull(History.earlier(all, listOf("redrawn", "by the program")))
        assertNull(History.earlier(all, listOf("", "")))
        assertNull(History.earlier(all, emptyList()))
    }
}

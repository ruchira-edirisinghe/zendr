package dev.zendr.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FeedTest {
    @Test fun notesWhenAnAgentStartsNeedingYouOrFinishesWork() {
        assertEquals("blocked", Feed.change("working", "blocked"))
        assertEquals("blocked", Feed.change(null, "blocked"))
        assertEquals("done", Feed.change("working", "done"))
    }

    @Test fun staysQuietOtherwise() {
        assertNull(Feed.change("blocked", "blocked"))
        assertNull(Feed.change("idle", "done"))
        assertNull(Feed.change("blocked", "working"))
        assertNull(Feed.change("done", "idle"))
        assertNull(Feed.change(null, null))
    }

    @Test fun keepsEachNoteThroughStorage() {
        val n = Note(7, 1000, "blocked", "Codex needs you", "On TEST-PC", "c1", "t2", "codex", "Codex", read = true)
        assertEquals(listOf(n), Feed.parse(Feed.encode(listOf(n))))
        val update = Note(8, 2000, "update", "Zendr 0.3.0 is out", "Steadier")
        assertEquals(listOf(update), Feed.parse(Feed.encode(listOf(update))))
    }

    @Test fun keepsTheNewestHundred() {
        val many = (1..150L).map { Note(it, it, "done", "n$it", "") }
        val kept = Feed.parse(Feed.encode(many))
        assertEquals(Feed.MOST, kept.size)
        assertEquals(1L, kept.first().id)
    }

    @Test fun aBrokenListReadsAsEmpty() {
        assertEquals(emptyList<Note>(), Feed.parse("not json"))
    }
}

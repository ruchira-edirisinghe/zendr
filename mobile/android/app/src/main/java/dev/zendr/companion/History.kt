package dev.zendr.companion

/** Reading back through a terminal's history on the phone. */
object History {
    /** How many lines the computer sends at most (terminal.screen and `hc read` stop at 2000). */
    const val MOST = 2000

    /**
     * How many of [fetched]'s lines come before [shown]: the earlier lines to add above what's on the
     * screen while you read back. [fetched] is a longer read of the same terminal, maybe with new
     * output at its end since [shown] was read. Null when [shown]'s first lines aren't in it (they
     * scrolled out of the history, or the program redrew them).
     */
    fun earlier(fetched: List<String>, shown: List<String>): Int? {
        if (shown.isEmpty()) return null
        // Match a few lines, starting at the first one with something on it, so a run of blank
        // lines doesn't match anywhere.
        val from = shown.indexOfFirst { it.isNotBlank() }.takeIf { it >= 0 } ?: return null
        val head = shown.subList(from, minOf(shown.size, from + 4)).map { it.trimEnd() }
        // shown sits at fetched's end, or further up when new lines came after it.
        val last = fetched.size - (shown.size - from)
        for (j in last downTo 0) {
            if (j >= from && j + head.size <= fetched.size && head.indices.all { fetched[j + it].trimEnd() == head[it] }) return j - from
        }
        return null
    }
}

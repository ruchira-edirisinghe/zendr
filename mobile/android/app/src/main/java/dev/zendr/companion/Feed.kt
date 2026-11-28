package dev.zendr.companion

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import org.json.JSONArray
import org.json.JSONObject

/**
 * One thing that happened: an agent started needing you ("blocked"), one finished ("done"), or a
 * new version of the app came out ("update").
 */
data class Note(
    val id: Long,
    val at: Long,
    val kind: String,
    val title: String,
    val text: String,
    val computer: String? = null,
    val terminal: String? = null,
    val app: String? = null,
    /** The session's own name, for opening it. */
    val session: String? = null,
    val read: Boolean = false,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("at", at).put("kind", kind).put("title", title).put("text", text)
        .put("computer", computer).put("terminal", terminal).put("app", app).put("session", session).put("read", read)

    companion object {
        fun fromJson(j: JSONObject) = Note(
            id = j.optLong("id"),
            at = j.optLong("at"),
            kind = j.optString("kind"),
            title = j.optString("title"),
            text = j.optString("text"),
            computer = j.optString("computer").takeIf { it.isNotEmpty() && it != "null" },
            terminal = j.optString("terminal").takeIf { it.isNotEmpty() && it != "null" },
            app = j.optString("app").takeIf { it.isNotEmpty() && it != "null" },
            session = j.optString("session").takeIf { it.isNotEmpty() && it != "null" },
            read = j.optBoolean("read"),
        )
    }
}

/**
 * The notifications list: everything the app saw happen, whether it saw it in the open app or in
 * Alert me's watch. Kept on the phone, newest first, the last [MOST].
 */
object Feed {
    const val MOST = 100

    /** Bumps whenever the list changes, so the bell and the list redraw. */
    var version by mutableIntStateOf(0)
        private set

    // computer id + terminal -> the status last seen, shared by the app's screens and the watch,
    // so one change is noted once.
    private val last = HashMap<String, String?>()
    private val known = HashSet<String>()

    /** What a change of status is worth noting as, if anything. */
    fun change(before: String?, now: String?): String? = when {
        before == now -> null
        now == "blocked" -> "blocked"
        now == "done" && before == "working" -> "done"
        else -> null
    }

    /** Notes what changed on [c] since it was last looked at (the first look only learns). */
    @Synchronized
    fun observe(store: Store, c: Computer, spaces: List<Space>) {
        val first = known.add(c.id)
        val now = System.currentTimeMillis()
        val fresh = mutableListOf<Note>()
        for (s in spaces.flatMap { it.sessions }) {
            val key = "${c.id}/${s.terminal}"
            val before = last[key]
            last[key] = s.status
            if (first) continue
            when (change(before, s.status)) {
                "blocked" -> fresh += Note(now + fresh.size, now, "blocked", "${s.title} needs you", "On ${c.name}", c.id, s.terminal, s.app, s.title)
                "done" -> fresh += Note(now + fresh.size, now, "done", "${s.title} finished", "On ${c.name}", c.id, s.terminal, s.app, s.title)
            }
        }
        if (fresh.isNotEmpty()) save(store, fresh + list(store))
    }

    /** A new version, noted once. */
    @Synchronized
    fun noteUpdate(store: Store, r: Release) {
        if (store.notedVersion == r.version) return
        store.notedVersion = r.version
        val now = System.currentTimeMillis()
        val text = Updates.summary(r.notes).lineSequence().firstOrNull { it.isNotBlank() } ?: "Tap to see what's new."
        save(store, listOf(Note(now, now, "update", "Zendr ${r.version} is out", text)) + list(store))
    }

    fun list(store: Store): List<Note> = parse(store.notesJson)

    fun unread(store: Store) = list(store).count { !it.read }

    @Synchronized
    fun markRead(store: Store, id: Long? = null) =
        save(store, list(store).map { if (id == null || it.id == id) it.copy(read = true) else it })

    @Synchronized
    fun remove(store: Store, id: Long) = save(store, list(store).filterNot { it.id == id })

    @Synchronized
    fun clear(store: Store) = save(store, emptyList())

    fun parse(raw: String): List<Note> = runCatching {
        val a = JSONArray(raw)
        (0 until a.length()).map { Note.fromJson(a.getJSONObject(it)) }
    }.getOrDefault(emptyList())

    fun encode(notes: List<Note>): String = JSONArray(notes.take(MOST).map { it.toJson() }).toString()

    private fun save(store: Store, notes: List<Note>) {
        store.notesJson = encode(notes)
        version++
    }
}

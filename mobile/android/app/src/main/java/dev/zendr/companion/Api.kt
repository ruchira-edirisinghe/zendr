package dev.zendr.companion

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.UUID

/** A computer this phone is paired with: its Zendr answers on one of [hosts] at [port]. */
data class Computer(
    val id: String,
    val name: String,
    val hosts: List<String>,
    val port: Int,
    val token: String,
    val lastHost: String? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("hosts", JSONArray(hosts)).put("port", port)
        .put("token", token).put("lastHost", lastHost)

    companion object {
        fun fromJson(j: JSONObject) = Computer(
            id = j.getString("id"),
            name = j.optString("name", "Computer"),
            hosts = j.optJSONArray("hosts")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
            port = j.optInt("port", 7425),
            token = j.getString("token"),
            lastHost = j.optString("lastHost").takeIf { it.isNotEmpty() && it != "null" },
        )

        /** zendr://pair?v=1&name=…&port=…&token=…&hosts=a,b (what the computer's QR code holds). */
        fun fromLink(link: String): Computer? {
            // Plain Java parsing (no android.net.Uri), so it's tested off a device.
            val uri = runCatching { URI(link.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "zendr" || uri.host != "pair") return null
            val q = (uri.rawQuery ?: return null).split('&').mapNotNull { part ->
                val i = part.indexOf('=')
                if (i <= 0) null else URLDecoder.decode(part.substring(0, i), "UTF-8") to URLDecoder.decode(part.substring(i + 1), "UTF-8")
            }.toMap()
            val token = q["token"]?.takeIf { it.length >= 16 && it.all(Char::isLetterOrDigit) } ?: return null
            val hosts = q["hosts"].orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }
            if (hosts.isEmpty()) return null
            val port = q["port"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: 7425
            return Computer(
                id = UUID.randomUUID().toString(),
                name = q["name"]?.takeIf { it.isNotBlank() } ?: "Computer",
                hosts = hosts,
                port = port,
                token = token,
            )
        }
    }
}

/** The paired computers and the alerts switch, kept in the app's private storage. */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("zendr", Context.MODE_PRIVATE)

    fun computers(): List<Computer> {
        val raw = prefs.getString("computers", null) ?: return emptyList()
        return runCatching {
            val a = JSONArray(raw)
            (0 until a.length()).map { Computer.fromJson(a.getJSONObject(it)) }
        }.getOrDefault(emptyList())
    }

    fun save(list: List<Computer>) {
        prefs.edit().putString("computers", JSONArray(list.map { it.toJson() }).toString()).apply()
    }

    /** Adds it, or replaces the one already paired with the same name and addresses. */
    fun add(c: Computer): Computer {
        val old = computers().firstOrNull { it.name == c.name && it.hosts.toSet() == c.hosts.toSet() }
        val saved = if (old != null) c.copy(id = old.id) else c
        save(computers().filterNot { it.id == saved.id } + saved)
        return saved
    }

    fun remove(id: String) = save(computers().filterNot { it.id == id })

    fun remember(id: String, host: String) {
        save(computers().map { if (it.id == id) it.copy(lastHost = host) else it })
    }

    var alerts: Boolean
        get() = prefs.getBoolean("alerts", false)
        set(v) = prefs.edit().putBoolean("alerts", v).apply()

    /** The terminal's text size in sp; 0 fits the computer's terminal to the phone's width. */
    var textSize: Float
        get() = prefs.getFloat("textSize", 0f)
        set(v) = prefs.edit().putFloat("textSize", v).apply()

    /** Long lines wrap to the phone's width instead of scrolling sideways. */
    var wrap: Boolean
        get() = prefs.getBoolean("wrap", false)
        set(v) = prefs.edit().putBoolean("wrap", v).apply()
}

class ApiError(message: String, val unpaired: Boolean = false) : Exception(message)

object Api {
    /** Calls the computer, trying the address that worked last, then each of the others. */
    suspend fun call(
        store: Store?,
        c: Computer,
        method: String,
        path: String,
        body: JSONObject? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        val order = (listOfNotNull(c.lastHost) + c.hosts).distinct()
        var refused: String? = null
        for (host in order) {
            try {
                val r = request(host, c.port, c.token, method, path, body)
                if (host != c.lastHost) store?.remember(c.id, host)
                return@withContext r
            } catch (e: Refused) {
                refused = e.message
            } catch (e: IOException) {
                // Not this address: try the next.
            }
        }
        throw ApiError(refused ?: "Can't reach ${c.name}. Check that Zendr is open there and Tailscale is on here.")
    }

    private class Refused(message: String) : IOException(message)

    private fun request(host: String, port: Int, token: String, method: String, path: String, body: JSONObject?): JSONObject {
        val h = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        val conn = URL("http://$h:$port$path").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 3500
            conn.readTimeout = 20000
            conn.requestMethod = method
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/json")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = conn.responseCode
            val text = (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            when {
                code == 401 -> throw ApiError("This phone isn't paired with it any more. Scan its code again.", unpaired = true)
                // Answered only over Tailscale: another address may work.
                code == 403 -> throw Refused(errorText(json) ?: "That computer only answers over Tailscale.")
                code >= 400 -> throw ApiError(errorText(json) ?: "The computer said: error $code")
            }
            return json
        } finally {
            conn.disconnect()
        }
    }

    fun errorText(j: JSONObject): String? = when (val e = j.opt("error")) {
        is String -> e
        is JSONObject -> e.optString("message").takeIf { it.isNotEmpty() }
        else -> null
    }

    suspend fun hello(store: Store?, c: Computer) = call(store, c, "GET", "/api/hello")
    suspend fun state(store: Store?, c: Computer) = parseState(call(store, c, "GET", "/api/state"))
    suspend fun read(store: Store?, c: Computer, terminal: String, lines: Int = 120): String =
        call(store, c, "GET", "/api/read?terminal=${URLEncoder.encode(terminal, "UTF-8")}&lines=$lines").optString("text")

    /**
     * A terminal's screen and recent history. A computer that can (Zendr 0.3 and later) sends it
     * with its colours and its theme; an older one, plain text.
     */
    suspend fun screen(store: Store?, c: Computer, terminal: String, lines: Int = 300): ScreenText {
        val j = call(store, c, "GET", "/api/read?terminal=${URLEncoder.encode(terminal, "UTF-8")}&lines=$lines&styled=1")
        return ScreenText(
            text = j.optString("text"),
            styled = j.optBoolean("styled", false),
            cols = j.optInt("cols", 0),
            palette = Palette.fromJson(j.optJSONObject("palette")),
        )
    }

    /** Commands from the computer's history that start with [prefix], best first (none from older ones). */
    suspend fun suggest(store: Store?, c: Computer, prefix: String, limit: Int = 3): List<String> {
        if (prefix.isBlank()) return emptyList()
        val j = runCatching {
            call(store, c, "GET", "/api/suggest?prefix=${URLEncoder.encode(prefix, "UTF-8")}&limit=$limit")
        }.getOrNull() ?: return emptyList()
        val a = j.optJSONArray("suggestions") ?: return emptyList()
        return (0 until a.length()).map { a.optString(it) }.filter { it.length > prefix.length && it.startsWith(prefix) }
    }

    /** Types [text] and presses Enter; [force] answers even an agent that's waiting on you. */
    suspend fun send(store: Store?, c: Computer, terminal: String, text: String, force: Boolean = false) =
        call(store, c, "POST", "/api/send", JSONObject().put("terminal", terminal).put("text", text).put("force", force))

    suspend fun keys(store: Store?, c: Computer, terminal: String, keys: List<String>) =
        call(store, c, "POST", "/api/keys", JSONObject().put("terminal", terminal).put("keys", JSONArray(keys)))

    suspend fun focus(store: Store?, c: Computer, terminal: String) =
        call(store, c, "POST", "/api/focus", JSONObject().put("terminal", terminal))
}

/** One running terminal: an agent or a shell. [status]: idle, working, blocked (needs you), done. */
data class Session(
    val terminal: String,
    val title: String,
    val app: String?,
    val status: String?,
    val tab: String,
)

data class Space(val id: String, val name: String, val sessions: List<Session>)

/** What `/api/read` sent: the text (with colour escapes when [styled]), how wide the terminal is. */
data class ScreenText(val text: String, val styled: Boolean, val cols: Int, val palette: Palette?)

private val APP_NAMES = mapOf(
    "claude-code" to "Claude Code", "codex" to "Codex", "gemini" to "Gemini", "opencode" to "opencode",
    "amp" to "Amp", "pi" to "Pi", "cursor-agent" to "Cursor",
)

fun parseState(j: JSONObject): List<Space> {
    val spaces = j.optJSONArray("spaces") ?: return emptyList()
    return (0 until spaces.length()).map { i ->
        val s = spaces.getJSONObject(i)
        val tabs = s.optJSONArray("tabs") ?: JSONArray()
        val sessions = (0 until tabs.length()).flatMap { ti ->
            val tab = tabs.getJSONObject(ti)
            val tabName = tab.optString("name")
            val terms = tab.optJSONArray("terminals") ?: JSONArray()
            (0 until terms.length()).map { k ->
                val t = terms.getJSONObject(k)
                val app = t.optString("app").takeIf { it.isNotEmpty() && it != "null" }
                val named = t.optString("name").takeIf { it.isNotEmpty() && it != "null" }
                val title = named ?: app?.let { APP_NAMES[it] ?: it }
                    ?: tabName.takeIf { it.isNotEmpty() && !it.all(Char::isDigit) } ?: "Terminal"
                Session(
                    terminal = t.getString("terminal"),
                    title = title,
                    app = app,
                    status = t.optString("status").takeIf { it.isNotEmpty() && it != "null" },
                    tab = tabName,
                )
            }
        }
        Space(s.optString("id"), s.optString("name", "Space"), sessions)
    }
}

fun statusLabel(status: String?): String = when (status) {
    "blocked" -> "Needs you"
    "working" -> "Working"
    "done" -> "Done"
    "idle" -> "Idle"
    else -> "Shell"
}

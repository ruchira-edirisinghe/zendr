package dev.zendr.companion

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ApiTest {
    // What `remote.pair` builds on the computer (src/remote.rs): names and hosts percent-encoded.
    private val link = "zendr://pair?v=1&name=MY%20PC&port=7425&token=0123456789abcdef0123456789abcdef0123456789abcdef&hosts=my-pc.tail1234.ts.net%2C100.101.102.103"

    @Test fun readsThePairingLink() {
        val c = Computer.fromLink(link)
        assertNotNull(c)
        assertEquals("MY PC", c!!.name)
        assertEquals(7425, c.port)
        assertEquals(listOf("my-pc.tail1234.ts.net", "100.101.102.103"), c.hosts)
        assertEquals(48, c.token.length)
    }

    @Test fun refusesWhatIsntAPairingLink() {
        assertNull(Computer.fromLink("https://example.com/?token=0123456789abcdef"))
        assertNull(Computer.fromLink("zendr://pair?v=1&port=7425&hosts=a"))                 // no token
        assertNull(Computer.fromLink("zendr://pair?token=0123456789abcdef0123&hosts="))     // no address
        assertNull(Computer.fromLink("zendr://pair?token=short&hosts=a"))
        assertNull(Computer.fromLink("not a link at all"))
        // A bad port falls back to the default instead of failing.
        assertEquals(7425, Computer.fromLink("zendr://pair?token=0123456789abcdef0123&hosts=a&port=99999")!!.port)
    }

    @Test fun keepsAComputerThroughJson() {
        val c = Computer.fromLink(link)!!.copy(lastHost = "100.101.102.103")
        assertEquals(c, Computer.fromJson(JSONObject(c.toJson().toString())))
        val none = Computer.fromLink(link)!!
        assertNull(Computer.fromJson(JSONObject(none.toJson().toString())).lastHost)
    }

    // The shape of `herdr-app ls` (and GET /api/state).
    private val state = """
        {"recent":[],"spaces":[{"id":"sp1","name":"web","folder":"C:\\x","machine":null,"active":true,"tabs":[
          {"id":"tb1","name":"1","active":true,"settled":false,"terminals":[
            {"terminal":"t10","pane":"p1","status":null,"app":null,"name":null,"sub_agents":[]},
            {"terminal":"t1w","pane":"p2","status":"blocked","app":"claude-code","name":null,"sub_agents":[]}]},
          {"id":"tb2","name":"server","active":false,"settled":true,"terminals":[
            {"terminal":"t2","pane":"p3","status":"working","app":"codex","name":"api","sub_agents":[]}]}]},
          {"id":"sp2","name":"empty","folder":"C:\\y","machine":null,"active":false,"tabs":[]}]}
    """.trimIndent()

    @Test fun readsSessionsWithTheirState() {
        val spaces = parseState(JSONObject(state))
        assertEquals(2, spaces.size)
        val s = spaces[0].sessions
        assertEquals(listOf("t10", "t1w", "t2"), s.map { it.terminal })
        assertEquals("Terminal", s[0].title)            // a shell in a numbered tab
        assertNull(s[0].status)
        assertEquals("Claude Code", s[1].title)
        assertEquals("blocked", s[1].status)
        assertEquals("api", s[2].title)                 // its own name wins over the program
        assertEquals("Needs you", statusLabel(s[1].status))
        assertEquals(0, spaces[1].sessions.size)
    }

    @Test fun readsErrorsBothWays() {
        assertEquals("no terminal \"x\"", Api.errorText(JSONObject("""{"error":{"kind":"not_found","message":"no terminal \"x\""}}""")))
        assertEquals("terminal: an address like t7", Api.errorText(JSONObject("""{"error":"terminal: an address like t7"}""")))
        assertNull(Api.errorText(JSONObject("{}")))
    }
}

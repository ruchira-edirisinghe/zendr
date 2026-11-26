package dev.zendr.companion

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The phone's own client against a real Zendr: run with ZENDR_LIVE_LINK (the pairing link from
 * `herdr-app do remote.pair`) and ZENDR_LIVE_TERMINAL (a scratch shell it may type into).
 * Skipped otherwise.
 */
class LiveTest {
    private val link: String? = System.getenv("ZENDR_LIVE_LINK")
    private val terminal: String? = System.getenv("ZENDR_LIVE_TERMINAL")

    @Test fun pairsReadsAndTypes(): Unit = runBlocking {
        assumeTrue("set ZENDR_LIVE_LINK and ZENDR_LIVE_TERMINAL", link != null && terminal != null)
        val c = Computer.fromLink(link!!)!!

        val hello = Api.hello(null, c)
        assertEquals("zendr", hello.getString("app"))

        val sessions = Api.state(null, c).flatMap { it.sessions }
        assertTrue("the scratch terminal is listed", sessions.any { it.terminal == terminal })

        val marker = "zendr-phone-${System.currentTimeMillis()}"
        Api.send(null, c, terminal!!, "echo $marker")
        var seen = false
        repeat(20) {
            if (!seen && Api.read(null, c, terminal).lines().count { it.contains(marker) } >= 2) seen = true
            if (!seen) delay(300)
        }
        assertTrue("the echo came back on the screen", seen)

        Api.keys(null, c, terminal, listOf("enter"))
        Api.focus(null, c, terminal)
    }

    @Test fun aWrongTokenIsRefused(): Unit = runBlocking {
        assumeTrue(link != null)
        val c = Computer.fromLink(link!!)!!.copy(token = "0".repeat(48))
        try {
            Api.hello(null, c)
            fail("a wrong token was answered")
        } catch (e: ApiError) {
            assertTrue(e.unpaired)
        }
    }

    @Test fun aMissingTerminalSaysSo(): Unit = runBlocking {
        assumeTrue(link != null)
        val c = Computer.fromLink(link!!)!!
        try {
            Api.read(null, c, "t-does-not-exist")
            fail("read a terminal that doesn't exist")
        } catch (e: ApiError) {
            assertTrue(e.message!!, e.message!!.contains("no terminal"))
        }
    }
}

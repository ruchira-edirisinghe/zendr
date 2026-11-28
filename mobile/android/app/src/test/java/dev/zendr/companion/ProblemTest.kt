package dev.zendr.companion

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import kotlin.concurrent.thread

/** Each way a computer can turn the phone down gets its own kind of problem (and screen). */
class ProblemTest {
    // A tiny computer that turns every request down, as Zendr does for each path.
    private val answers = mapOf(
        "/api/hello" to (401 to """{"error":"not paired"}"""),
        "/api/read" to (502 to """{"error":"no terminal t9"}"""),
        "/api/state" to (502 to """{"error":"cannot run the core: not found"}"""),
    )
    private lateinit var server: ServerSocket

    @Before fun start() {
        server = ServerSocket(0)
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val s = runCatching { server.accept() }.getOrNull() ?: break
                s.use {
                    val path = it.getInputStream().bufferedReader().readLine().orEmpty().split(' ').getOrNull(1).orEmpty().substringBefore('?')
                    val (code, body) = answers[path] ?: (404 to """{"error":"no such route"}""")
                    val b = body.toByteArray()
                    val head = "HTTP/1.1 $code X\r\nContent-Type: application/json\r\nContent-Length: ${b.size}\r\nConnection: close\r\n\r\n"
                    it.getOutputStream().write(head.toByteArray() + b)
                    it.getOutputStream().flush()
                }
            }
        }
    }

    @After fun stop() = server.close()

    private fun computer(port: Int = server.localPort) =
        Computer("c1", "TEST-PC", listOf("127.0.0.1"), port, "0123456789abcdef0123456789abcdef")

    private fun kindOf(block: suspend () -> Unit): Problem = runBlocking {
        try {
            block()
            fail("it was answered")
            throw IllegalStateException()
        } catch (e: ApiError) {
            e.problem()
        }
    }

    @Test fun aNewPairingCodeIsUnpaired() = assertEquals(Problem.Unpaired, kindOf { Api.hello(null, computer()) })

    @Test fun aClosedSessionIsGone() = assertEquals(Problem.Gone, kindOf { Api.read(null, computer(), "t9") })

    @Test fun theCoresOwnTroubleIsTheServers() = assertEquals(Problem.Server, kindOf { Api.state(null, computer()) })

    @Test fun anUnknownRouteMeansAnOlderZendr() =
        assertEquals(Problem.Outdated, kindOf { Api.call(null, computer(), "GET", "/api/suggest?prefix=x") })

    @Test fun nobodyAnsweringIsOffline() {
        val free = ServerSocket(0).use { it.localPort }
        assertEquals(Problem.Offline, kindOf { Api.hello(null, computer(free)) })
    }

    @Test fun otherFailuresCountAsOffline() = assertEquals(Problem.Offline, RuntimeException("x").problem())
}

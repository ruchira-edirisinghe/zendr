package dev.zendr.companion

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections

/**
 * The whole app on a device against a fake Zendr (what src/remote.rs answers): pair from a
 * link, see who needs you, read a screen, answer it, press a key, and get the "needs you" alert.
 */
@RunWith(AndroidJUnit4::class)
class FlowTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val token = "0123456789abcdef0123456789abcdef0123456789abcdef"
    private val server = MockWebServer()
    private val received: MutableList<String> = Collections.synchronizedList(mutableListOf())
    @Volatile private var claudeNeedsYou = false
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun state(): String {
        val claude = if (claudeNeedsYou) "blocked" else "working"
        return """{"recent":[],"spaces":[{"id":"sp1","name":"web-shop","folder":"/x","machine":null,"active":true,"tabs":[
            {"id":"tb1","name":"1","active":true,"settled":false,"terminals":[
              {"terminal":"t1","pane":"p1","status":"$claude","app":"claude-code","name":null,"sub_agents":[]},
              {"terminal":"t2","pane":"p2","status":"blocked","app":"codex","name":null,"sub_agents":[]}]}]}]}"""
    }

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    @Before fun start() {
        context.getSharedPreferences("zendr", 0).edit().clear().commit()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.getHeader("Authorization") != "Bearer $token") {
                    return MockResponse().setResponseCode(401).setBody("""{"error":"not paired"}""")
                }
                return when (request.path?.substringBefore('?')) {
                    "/api/hello" -> json("""{"app":"zendr","version":"0.2.0","name":"TEST-PC","os":"windows"}""")
                    "/api/state" -> json(state())
                    "/api/read" -> json("""{"text":"Codex wants to run: npm test\n> 1. Yes\n  2. No"}""")
                    "/api/send", "/api/keys", "/api/focus" -> {
                        received += request.path + " " + request.body.readUtf8()
                        json("""{"ok":true}""")
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun stop() {
        WatchService.stop(context)
        server.shutdown()
    }

    private fun shown(text: String) =
        compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()

    private fun waitForText(text: String, ms: Long = 15_000) =
        compose.waitUntil(ms) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }

    @Test fun pairsShowsWhoNeedsYouAndAnswers() {
        val link = "zendr://pair?v=1&name=TEST-PC&port=${server.port}&token=$token&hosts=127.0.0.1"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(context, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(intent).use {
            // Paired from the link and straight to its sessions: Codex is waiting.
            waitForText("Needs you")
            waitForText("Codex")
            compose.onAllNodesWithText("Codex").onFirst().performClick()

            // Its screen, then an answer typed and sent, then a quick key.
            waitForText("wants to run: npm test")
            compose.onNode(hasSetTextAction()).performTextInput("yes, run it")
            compose.onNodeWithContentDescription("Send").performClick()
            compose.waitUntil(10_000) { received.any { it.startsWith("/api/send") && it.contains("yes, run it") && it.contains("\"t2\"") } }
            compose.onAllNodesWithText("Esc").onFirst().performClick()
            compose.waitUntil(10_000) { received.any { it.startsWith("/api/keys") && it.contains("esc") } }

            // Back to the computers: it's listed and remembered. (The keyboard is still up from
            // the reply, and Back closes it first, so step back until the home screen shows.)
            Espresso.closeSoftKeyboard()
            repeat(3) {
                if (!shown("Alert me")) {
                    Espresso.pressBack()
                    compose.waitForIdle()
                }
            }
            waitForText("Alert me")
            waitForText("TEST-PC")
            assertTrue(Store(context).computers().single().name == "TEST-PC")

            // Alert me: the service sees Claude go from working to needing you, and says so.
            compose.onNode(isToggleable()).performClick()
            Thread.sleep(4000) // its first look: Claude is working
            claudeNeedsYou = true
            val nm = context.getSystemService(NotificationManager::class.java)
            val deadline = System.currentTimeMillis() + 45_000
            var alerted = false
            while (!alerted && System.currentTimeMillis() < deadline) {
                alerted = nm.activeNotifications.any { it.notification.extras.getString("android.title") == "Claude Code needs you" }
                if (!alerted) Thread.sleep(1000)
            }
            assertTrue("a 'Claude Code needs you' notification", alerted)
        }
    }

    @Test fun aBadLinkIsExplained() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("zendr://pair?v=1&hosts=127.0.0.1")).setClass(context, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(intent).use {
            waitForText("isn't a Zendr pairing code")
        }
    }
}

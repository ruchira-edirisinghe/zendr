package dev.zendr.companion

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatesTest {
    @Test fun comparesVersionsByNumber() {
        assertTrue(Updates.newer("0.2.3", "0.2.2"))
        assertTrue(Updates.newer("v0.10.0", "0.9.9"))
        assertTrue(Updates.newer("1.0", "0.9.12"))
        assertFalse(Updates.newer("0.2.2", "0.2.2"))
        assertFalse(Updates.newer("0.2.1", "0.2.2"))
        assertFalse(Updates.newer("0.2.2", "0.2.2.0"))
    }

    @Test fun aReleaseComesAfterItsPreRelease() {
        assertTrue(Updates.newer("0.3.0", "0.3.0-beta.1"))
        assertFalse(Updates.newer("0.3.0-beta.1", "0.3.0"))
        assertTrue(Updates.newer("0.3.0-beta.1", "0.2.9"))
    }

    @Test fun readsGitHubsLatestRelease() {
        val j = JSONObject(
            """{"tag_name":"v0.2.3","html_url":"https://github.com/x/zendr/releases/tag/v0.2.3","body":"Hi",
               "assets":[{"name":"Zendr-0.2.3-windows-x64.zip","browser_download_url":"https://x/win.zip"},
                         {"name":"Zendr-0.2.3-android.apk","browser_download_url":"https://x/app.apk"}]}""",
        )
        val r = Updates.parse(j)!!
        assertEquals("0.2.3", r.version)
        assertEquals("https://x/app.apk", r.apk)
        assertEquals("https://github.com/x/zendr/releases/tag/v0.2.3", r.page)
    }

    @Test fun aReleaseWithoutTheApkStillHasItsPage() {
        val r = Updates.parse(JSONObject("""{"tag_name":"v1.0.0","assets":[]}"""))!!
        assertNull(r.apk)
        assertTrue(r.page.endsWith("/releases/latest"))
        assertNull(Updates.parse(JSONObject("""{"message":"Not Found"}""")))
    }

    @Test fun notesKeepTheOpeningAndWhatsNew() {
        val md = """
            Zendr 0.2.3: **steadier** phones.

            ## Install

            | Your device | Download |
            | --- | --- |
            - **Windows:** run install.ps1

            ## What's new

            - 📜 **Scroll back** through `2,000` lines. See the [README](https://x).
            - Fixes.

            **Full Changelog**: https://x
        """.trimIndent()
        assertEquals(
            "Zendr 0.2.3: steadier phones.\n\n• 📜 Scroll back through 2,000 lines. See the README.\n• Fixes.",
            Updates.summary(md),
        )
    }
}

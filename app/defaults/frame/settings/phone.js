// Settings → Phone: pair the Zendr app on a phone with this computer (src/remote.rs).
// remote.pair turns the phone server on and makes the pairing link and its QR code, which only
// this mod reads (phonePairing()); remote.status puts the switch's state in shared "remote.status".

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, run, shared, phonePairing, window } from "herdr";

const I = (name) => `frame/settings/${name}.svg`;

// The link, on the clipboard: PowerShell on Windows, pbcopy on macOS, wl-copy or xclip on Linux.
function copyText(text) {
  const p = window()?.platform;
  if (p === "windows") return exec("powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value $args[0]", text], { timeout: 10000 });
  if (p === "macos") return exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text], { timeout: 10000 });
  return exec("sh", ["-c", 'printf %s "$1" | (wl-copy 2>/dev/null || xclip -selection clipboard)', "sh", text], { timeout: 10000 });
}

export const phoneMethods = {
  loadPhone() {
    run("remote.status");
  },

  // The QR code: one square per module, with the quiet zone the scanners want.
  phoneQr(t, rows) {
    const n = rows.length, cell = n > 45 ? 4 : 5;
    return v_flex().flex_none().p(cell * 4).bg("#ffffff").rounded(10)
      .children(rows.map((row, y) => h_flex().flex_none()
        .children([...row].map((bit, x) => div().id(`qr-${y}-${x}`).size(cell).flex_none().bg(bit === "1" ? "#000000" : "#ffffff")))));
  },

  phonePage(t) {
    const status = shared("remote.status") ?? {};
    const pairing = status.enabled ? phonePairing() : null;
    const ts = pairing?.tailscale ?? {};
    const btn = (id, label, action, primary = false) => div().id(id).h(32).px(14).flex().items_center().rounded(8).cursor_pointer()
      .text_size(13).font_medium().bg(primary ? t.accent : t.raised).text_color(primary ? t.background : t.foreground)
      .border_1().border_color(primary ? t.accent : t.border).hover((s) => s.opacity(0.85))
      .on_click(() => action()).child(label);
    const step = (n, title, body) => h_flex().gap(12).items_start()
      .child(div().size(24).flex_none().rounded(12).bg(t.accent + "26").flex().items_center().justify_center()
        .text_size(12).font_bold().text_color(t.accent).child(String(n)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(13.5).font_medium().text_color(t.foreground).child(title))
        .child(div().text_size(12.5).text_color(t.muted).child(body)));
    const note = (color, text) => div().p(10).rounded(8).bg(color + "1f").border_1().border_color(color + "55")
      .text_size(12.5).text_color(t.foreground).child(text);

    const page = v_flex().gap(18).max_w(720)
      .child(v_flex().gap(4)
        .child(div().text_size(20).font_semibold().text_color(t.foreground).child("Phone"))
        .child(div().min_w(0).text_size(13).text_color(t.muted)
          .child("See your sessions from the Zendr app on Android, get an alert when an agent needs you, and answer it from wherever you are. Your phone reaches this computer through Tailscale, a free private network, so nothing is open to the internet.")))
      .child(v_flex().gap(12).p(16).rounded(10).bg(t.raised).border_1().border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Set it up once"))
        .child(step(1, "Install Tailscale here and on your phone", "From tailscale.com/download (free for personal use). Sign in to the same account on both."))
        .child(step(2, "Install the Zendr app on your phone", "Zendr-<version>.apk from the GitHub release. Android asks once to allow installing it."))
        .child(step(3, "Show the pairing code below and scan it", "In the app: Add computer → Scan the code. The 6-letter code under the QR code should match on both screens."))
        .child(step(4, "Turn on Alert me in the app", "It checks every 20 seconds and tells you when an agent needs you or finishes.")));

    if (!status.enabled) {
      return page.child(h_flex().gap(10).items_center()
        .child(btn("phone-on", "Show pairing code", () => run("remote.pair"), true))
        .child(div().text_size(12.5).text_color(t.muted).child("Turns on the phone connection. Off until you do.")));
    }
    if (!pairing) {
      return page.child(h_flex().gap(10).items_center()
        .child(btn("phone-show", "Show pairing code", () => run("remote.pair"), true))
        .child(btn("phone-off", "Turn off", () => run("remote.stop")))
        .child(div().text_size(12.5).text_color(t.muted).child(`On, port ${status.port}.`)));
    }
    const hosts = pairing.hosts ?? [];
    return page
      .when(!ts.installed, (el) => el.child(note(t.blocked, "Tailscale isn't installed on this computer. Install it from tailscale.com/download and sign in, then press Refresh code.")))
      .when(Boolean(ts.installed) && !ts.online, (el) => el.child(note(t.working, "Tailscale is installed but not signed in. Open Tailscale, sign in, then press Refresh code.")))
      .when(hosts.length === 0, (el) => el.child(note(t.blocked, "No address to reach this computer yet: sign in to Tailscale (or allow the local network below), then press Refresh code.")))
      .child(h_flex().gap(22).items_start()
        .child(this.phoneQr(t, pairing.qr ?? []))
        .child(v_flex().flex_1().min_w(0).gap(12)
          .child(v_flex().gap(2)
            .child(div().text_size(12).text_color(t.muted).child("Code to match on the phone"))
            .child(div().text_size(26).font_bold().text_color(t.foreground).child(pairing.code ?? "")))
          .child(v_flex().gap(2)
            .child(div().text_size(12).text_color(t.muted).child("Reaches this computer at"))
            .children((hosts.length ? hosts : ["(none yet)"]).map((h, i) => div().id(`host-${i}`).text_size(13).text_color(t.foreground).child(`${h}:${pairing.port}`))))
          .child(h_flex().gap(8).flex_wrap()
            .child(btn("phone-copy", "Copy link", () => copyText(pairing.link)))
            .child(btn("phone-refresh", "Refresh code", () => run("remote.pair")))
            .child(btn("phone-lan", pairing.lan ? "Tailscale only" : "Allow local network", () => run("remote.pair", { lan: !pairing.lan })))
            .child(btn("phone-reset", "Unpair all phones", () => run("remote.pair", { reset: true })))
            .child(btn("phone-off", "Turn off", () => run("remote.stop"))))
          .child(div().text_size(12).text_color(t.dim).child(pairing.lan
            ? "Also answering this computer's local network: anyone on it who has the code can connect, and the network doesn't encrypt it. Use Tailscale only on shared Wi-Fi."
            : "Only answers over Tailscale, which encrypts everything end to end. The code is like a password: Unpair all phones makes a new one."))));
  },
};

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, shared, setShared } from "herdr";

const REFRESH_MS = 5 * 60 * 1000;
const DAY = 86400000;
const PERIOD_LABELS = { zh: ["7 天", "30 天", "90 天", "全部"], en: ["7d", "30d", "90d", "All"] };
const TOP = 10;
const UI_KEY = "skill-ledger.ui";

const TXT = {
  zh: {
    title: "技能 & MCP 用量", refresh: "刷新", loading: "正在读取日志…", updated: "更新于", skills: "Skill", mcp: "MCP",
    installed: "已安装", used: "本期用过", never: "从未用过", calls: "调用",
    top: "最常用 Top 10", bottom: "最少用 Bottom 10", byCat: "按类别", bySource: "按来源",
    times: (n) => `${n} 次`, unused: "0 次", otherZero: (n) => `另有 ${n} 个同为 0 次`,
    noneUsed: "这段时间没有调用记录。", lastUsed: "上次使用", never2: "从未使用", today: "今天", yesterday: "昨天", daysAgo: (d) => `${d} 天前`,
    auto: "模型调用", manual: "手动 /命令", loads: "读取 SKILL.md", installedIn: "安装于", category: "类别", notInstalled: "未安装", removedNote: "日志里出现过，但现在没有安装（或是内置 / 云端同步）",
    servers: (n) => `${n} 个服务器`, items: (n) => `${n} 个`, tools: "工具", noTools: "没有调用记录", total: "合计",
    noLogs: "没有找到 Claude Code 或 Pi 的日志。", error: "读取失败：",
    howCounted: "计数方式：Claude Code = Skill 工具调用 + 手动 /命令；Pi = 读取 SKILL.md。重复记录只算一次。",
    mcpCounted: "MCP 按服务器汇总，点开看各工具。Claude Code 读取 mcp__服务器__工具，Pi 读取 服务器__工具。",
    agentNames: { claude: "Claude Code", pi: "Pi" }, bottomNote: "按次数从少到多；次数相同时，更久没用的在前。仅含已安装项。",
  },
  en: {
    title: "Skills & MCP usage", refresh: "Refresh", loading: "Reading logs…", updated: "Updated", skills: "Skills", mcp: "MCP",
    installed: "Installed", used: "Used", never: "Never used", calls: "Calls",
    top: "Most used · Top 10", bottom: "Least used · Bottom 10", byCat: "By category", bySource: "By source",
    times: (n) => `${n}×`, unused: "0×", otherZero: (n) => `${n} more with 0 calls`,
    noneUsed: "No calls in this period.", lastUsed: "Last used", never2: "Never used", today: "today", yesterday: "yesterday", daysAgo: (d) => `${d}d ago`,
    auto: "by the model", manual: "by /command", loads: "SKILL.md reads", installedIn: "Installed for", category: "Category", notInstalled: "not installed", removedNote: "Seen in the logs but not installed now (removed, built-in or synced from the cloud)",
    servers: (n) => `${n} servers`, items: (n) => `${n}`, tools: "Tools", noTools: "No calls recorded", total: "Total",
    noLogs: "No Claude Code or Pi logs found.", error: "Failed: ",
    howCounted: "Counted as: Claude Code = Skill tool calls + manual /commands; Pi = reads of SKILL.md. Repeated records count once.",
    mcpCounted: "MCP is grouped by server; open one for its tools. Claude Code logs mcp__server__tool, Pi logs server__tool.",
    agentNames: { claude: "Claude Code", pi: "Pi" }, bottomNote: "Fewest calls first; ties go to the one unused longest. Installed items only.",
  },
};

const clock = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export default class SkillLedger extends View {
  init(_props, cx) {
    this.data = null; this.error = null; this.loading = false;
    const saved = (() => { try { return shared(UI_KEY) ?? {}; } catch { return {}; } })();
    this.period = Number.isInteger(saved.period) ? saved.period : 1; // default: 30 days
    this.tab = saved.tab === "mcp" ? "mcp" : "skills";
    this.open = new Map(Object.entries(saved.open ?? {}));
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  persist() {
    try { setShared(UI_KEY, { period: this.period, tab: this.tab, open: Object.fromEntries(this.open) }); } catch {}
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", [`${appHome()}/mods/skill-ledger/collect.mjs`, `${appHome()}/data/skill-ledger`]);
        if (r.code !== 0) throw new Error((r.stderr || "collector failed").trim().slice(0, 160));
        this.data = JSON.parse(r.stdout); this.error = null;
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  isOpen(key, def) { return this.open.has(key) ? this.open.get(key) : def; }
  toggle(key, def, cx) { this.open.set(key, !this.isOpen(key, def)); this.persist(); cx.notify(); }

  // ---------- small pieces ----------
  ago(L, ms) {
    if (!ms) return L.never2;
    const d = Math.floor((Date.now() - ms) / DAY);
    return d <= 0 ? L.today : d === 1 ? L.yesterday : L.daysAgo(d);
  }

  chev(t, open) { return div().w(12).flex_none().text_size(10).text_color(t.dim).child(open ? "▾" : "▸"); }

  // A collapsible card: clicking the header folds or unfolds the body.
  section(t, key, title, tag, defOpen, cx, body) {
    const open = this.isOpen(key, defOpen);
    return v_flex().w_full().flex_none().rounded(10).border_1().border_color(t.border).bg(t.raised).overflow_hidden()
      .child(h_flex().id(`sec-${key}`).w_full().h(34).px(12).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, c) => this.toggle(key, defOpen, c))
        .child(this.chev(t, open))
        .child(div().font_semibold().text_size(13).child(title))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(t.dim).child(tag)))
      .when(open, (el) => el.child(v_flex().w_full().gap(2).px(8).pb(10).pt(2).children(body())));
  }

  note(t, text, color) { return div().px(4).py(2).text_size(10).text_color(color ?? t.dim).child(text); }

  // One ranked row; click it to see the details.
  row(t, L, cx, { key, rank, name, tag, n, max, color, lines }) {
    const open = this.isOpen(key, false);
    return v_flex().id(`row-${key}`).w_full().gap(3).px(4).py(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, c) => this.toggle(key, false, c))
      .child(h_flex().w_full().items_center().gap(6).text_size(12)
        .child(div().w(14).flex_none().text_color(t.dim).text_size(11).child(rank == null ? "" : String(rank)))
        .child(div().min_w(0).truncate().text_color(n === 0 ? t.muted : t.foreground).child(name))
        .child(tag ? div().flex_none().text_size(10).text_color(t.dim).child(tag) : div())
        .child(div().flex_1())
        .child(div().flex_none().text_color(n === 0 ? t.dim : t.foreground).child(n === 0 ? L.unused : L.times(n))))
      .child(div().w_full().h(3).rounded(2).bg(t.border).overflow_hidden().child(div().h_full().w(`${n > 0 ? Math.max(2, Math.round((100 * n) / Math.max(1, max))) : 0}%`).rounded(2).bg(color)))
      .when(open, (el) => el.child(v_flex().gap(2).pl(20).pt(2).children(lines.map((x) => div().text_size(11).text_color(t.dim).child(x)))));
  }

  // ---------- skills ----------
  skillRows(t, L, cx, list, keyPrefix, color, withRank) {
    const p = this.period, max = Math.max(1, ...this.data.skills.map((s) => s.n[p]));
    return list.map((s, i) => {
      const a = L.agentNames, parts = [];
      if (s.claude[p] || s.claudeCmd[p]) parts.push(`${a.claude}: ${L.times(s.claude[p] + s.claudeCmd[p])}${s.claude[p] && s.claudeCmd[p] ? ` (${L.auto} ${s.claude[p]} + ${L.manual} ${s.claudeCmd[p]})` : s.claudeCmd[p] ? ` (${L.manual})` : ""}`);
      if (s.pi[p]) parts.push(`${a.pi}: ${L.times(s.pi[p])} (${L.loads})`);
      const lines = [];
      if (s.description) lines.push(s.description);
      lines.push(parts.length ? parts.join("  ·  ") : L.noneUsed);
      lines.push(`${L.lastUsed}: ${this.ago(L, s.last)}  ·  ${L.category}: ${s.category[this.data.lang]}`);
      lines.push(s.installed ? `${L.installedIn}: ${s.agents.map((x) => a[x] ?? x).join(", ")}` : L.removedNote);
      return this.row(t, L, cx, { key: `${keyPrefix}-${s.name}`, rank: withRank ? i + 1 : null, name: s.name, tag: s.installed ? s.agents.map((x) => (x === "claude" ? "CC" : "Pi")).join("·") : L.notInstalled, n: s.n[p], max, color, lines });
    });
  }

  skillsView(t, L, cx) {
    const p = this.period, all = this.data.skills, inst = all.filter((s) => s.installed);
    const used = all.filter((s) => s.n[p] > 0).sort((a, b) => b.n[p] - a.n[p] || b.last - a.last || a.name.localeCompare(b.name));
    const unused = inst.filter((s) => s.n[p] === 0);
    // Least used: fewest calls first; among equals, the one unused longest.
    const least = [...inst].sort((a, b) => a.n[p] - b.n[p] || a.last - b.last || a.name.localeCompare(b.name));
    const bottom = least.slice(0, TOP), rest = least.slice(TOP).filter((s) => s.n[p] === bottom[bottom.length - 1]?.n[p]);
    const total = all.reduce((n, s) => n + s.n[p], 0);

    const cats = new Map();
    for (const s of all) { const c = cats.get(s.category.id) ?? { cat: s.category, list: [], calls: 0 }; c.list.push(s); c.calls += s.n[p]; cats.set(s.category.id, c); }
    const groups = [...cats.values()].sort((a, b) => b.calls - a.calls || b.list.length - a.list.length);

    return [
      this.summary(t, L, [[L.installed, inst.length], [L.used, used.filter((s) => s.installed).length], [L.never, unused.length], [L.calls, total]]),
      this.section(t, "s-top", L.top, L.items(Math.min(TOP, used.length)), true, cx, () => used.length
        ? this.skillRows(t, L, cx, used.slice(0, TOP), "top", t.ansi4, true) : [this.note(t, L.noneUsed)]),
      this.section(t, "s-bottom", L.bottom, `${L.never}: ${unused.length}`, true, cx, () => [
        ...this.skillRows(t, L, cx, bottom, "bot", t.ansi3, true),
        ...(rest.length ? [h_flex().id("zero-rest").w_full().px(4).py(4).gap(6).items_start().cursor_pointer().on_click((_e, c) => this.toggle("zero-rest", false, c))
          .child(this.chev(t, this.isOpen("zero-rest", false))).child(div().flex_1().text_size(11).text_color(t.dim).child(this.isOpen("zero-rest", false) ? rest.map((s) => s.name).join(" · ") : L.otherZero(rest.length)))] : []),
        this.note(t, L.bottomNote)]),
      this.section(t, "s-cat", L.byCat, L.items(groups.length), false, cx, () => groups.map((g) => {
        const key = `cat-${g.cat.id}`, open = this.isOpen(key, false);
        return v_flex().w_full().gap(1)
          .child(h_flex().id(`cat-${g.cat.id}`).w_full().h(28).px(4).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, c) => this.toggle(key, false, c))
            .child(this.chev(t, open))
            .child(div().text_size(12).font_semibold().child(g.cat[this.data.lang]))
            .child(div().flex_1())
            .child(div().text_size(10).text_color(t.dim).child(`${L.items(g.list.length)} · ${L.times(g.calls)}`)))
          .when(open, (el) => el.child(v_flex().w_full().pl(10).children(this.skillRows(t, L, cx, [...g.list].sort((a, b) => b.n[p] - a.n[p] || a.name.localeCompare(b.name)), `c-${g.cat.id}`, t.ansi4, false))));
      })),
      this.note(t, L.howCounted),
    ];
  }

  // ---------- MCP ----------
  serverRows(t, L, cx, list, keyPrefix, color, withRank, showAgent = true) {
    const p = this.period, max = Math.max(1, ...this.data.mcp.map((m) => m.n[p]));
    return list.map((m, i) => {
      const tools = m.tools.filter((x) => x.n[p] > 0);
      const lines = tools.length ? tools.slice(0, 12).map((x) => `${x.name}  ·  ${L.times(x.n[p])}`) : [L.noTools];
      if (tools.length > 12) lines.push(`… +${tools.length - 12}`);
      lines.push(`${L.lastUsed}: ${this.ago(L, m.last)}`);
      if (!m.installed) lines.push(L.removedNote);
      return this.row(t, L, cx, { key: `${keyPrefix}-${m.agent}-${m.name}`, rank: withRank ? i + 1 : null, name: m.name, tag: showAgent ? L.agentNames[m.agent] ?? m.agent : m.installed ? "" : L.notInstalled, n: m.n[p], max, color, lines });
    });
  }

  mcpView(t, L, cx) {
    const p = this.period, all = this.data.mcp, inst = all.filter((m) => m.installed);
    const used = all.filter((m) => m.n[p] > 0).sort((a, b) => b.n[p] - a.n[p] || b.last - a.last || a.name.localeCompare(b.name));
    const unused = inst.filter((m) => m.n[p] === 0);
    const least = [...inst].sort((a, b) => a.n[p] - b.n[p] || a.last - b.last || a.name.localeCompare(b.name));
    const bottom = least.slice(0, TOP), rest = least.slice(TOP).filter((m) => m.n[p] === bottom[bottom.length - 1]?.n[p]);
    const total = all.reduce((n, m) => n + m.n[p], 0);
    const bySource = ["claude", "pi"].map((a) => ({ agent: a, list: all.filter((m) => m.agent === a).sort((x, y) => y.n[p] - x.n[p] || x.name.localeCompare(y.name)) })).filter((g) => g.list.length);

    return [
      this.summary(t, L, [[L.installed, inst.length], [L.used, used.filter((m) => m.installed).length], [L.never, unused.length], [L.calls, total]]),
      this.section(t, "m-top", L.top, L.servers(Math.min(TOP, used.length)), true, cx, () => used.length ? this.serverRows(t, L, cx, used.slice(0, TOP), "mtop", t.ansi4, true) : [this.note(t, L.noneUsed)]),
      this.section(t, "m-bottom", L.bottom, `${L.never}: ${unused.length}`, true, cx, () => [
        ...this.serverRows(t, L, cx, bottom, "mbot", t.ansi3, true),
        ...(rest.length ? [h_flex().id("mzero-rest").w_full().px(4).py(4).gap(6).items_start().cursor_pointer().on_click((_e, c) => this.toggle("mzero-rest", false, c))
          .child(this.chev(t, this.isOpen("mzero-rest", false))).child(div().flex_1().text_size(11).text_color(t.dim).child(this.isOpen("mzero-rest", false) ? rest.map((m) => m.name).join(" · ") : L.otherZero(rest.length)))] : []),
        this.note(t, L.bottomNote)]),
      this.section(t, "m-src", L.bySource, L.items(bySource.length), false, cx, () => bySource.map((g) => {
        const key = `src-${g.agent}`, open = this.isOpen(key, false), calls = g.list.reduce((n, m) => n + m.n[p], 0);
        return v_flex().w_full().gap(1)
          .child(h_flex().id(`src-${g.agent}`).w_full().h(28).px(4).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, c) => this.toggle(key, false, c))
            .child(this.chev(t, open)).child(div().text_size(12).font_semibold().child(L.agentNames[g.agent]))
            .child(div().flex_1()).child(div().text_size(10).text_color(t.dim).child(`${L.servers(g.list.length)} · ${L.times(calls)}`)))
          .when(open, (el) => el.child(v_flex().w_full().pl(10).children(this.serverRows(t, L, cx, g.list, `msrc-${g.agent}`, t.ansi4, false, false))));
      })),
      this.note(t, L.mcpCounted),
    ];
  }

  summary(t, L, items) {
    return h_flex().w_full().flex_none().gap(6).children(items.map(([label, value]) =>
      v_flex().flex_1().min_w(0).gap(1).px(8).py(6).rounded(8).border_1().border_color(t.border).bg(t.raised)
        .child(div().text_size(16).font_semibold().child(String(value)))
        .child(div().text_size(10).text_color(t.dim).truncate().child(label))));
  }

  pill(t, id, label, on, onClick) {
    return div().id(id).h(22).px(8).flex().items_center().rounded(6).text_size(11).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(on ? t.selected : t.hover)).on_click(onClick).child(label);
  }

  render(cx) {
    const t = theme(), lang = this.data?.lang === "zh" ? "zh" : "en", L = TXT[lang];
    let body;
    if (!this.data) body = [div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(this.error ? `${L.error}${this.error}` : L.loading)];
    else if (!this.data.logs.claude && !this.data.logs.pi) body = [div().p(8).text_color(t.dim).child(L.noLogs)];
    else body = this.tab === "mcp" ? this.mcpView(t, L, cx) : this.skillsView(t, L, cx);
    return v_flex().id("skill-ledger").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child(L.title))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(this.loading ? L.loading : this.data ? `${L.updated} ${clock(this.data.at)}` : ""))
        .child(div().id("sl-refresh").h(24).px(8).flex().items_center().rounded(6).text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, c) => this.refresh(c)).child(L.refresh)))
      .child(h_flex().h(34).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.pill(t, "tab-skills", L.skills, this.tab === "skills", (_e, c) => { this.tab = "skills"; this.persist(); c.notify(); }))
        .child(this.pill(t, "tab-mcp", L.mcp, this.tab === "mcp", (_e, c) => { this.tab = "mcp"; this.persist(); c.notify(); }))
        .child(div().flex_1())
        .children(PERIOD_LABELS[lang].map((label, i) => this.pill(t, `period-${i}`, label, this.period === i, (_e, c) => { this.period = i; this.persist(); c.notify(); }))))
      .when(Boolean(this.error && this.data), (e) => e.child(div().px(14).pt(8).text_size(11).text_color(t.ansi1).child(`${L.error}${this.error}`)))
      .child(v_flex().id("sl-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10).children(body));
  }
}

// Default skill categories. A skill's name is matched against the rules first, then its
// description; the first rule that matches wins. Override any skill (or invent your own
// category) in <app home>/data/skill-ledger/categories.json:  { "my-skill": "Research" }
export const CATEGORIES = [
  { id: "memory",   zh: "会话与记忆", en: "Memory & sessions", re: /checkpoint|recap|recall|memory|resume|session|handoff|progress|存档|恢复|记忆|进度|会话/ },
  { id: "terminal", zh: "终端与 Agent", en: "Terminal & agents", re: /herdr|terminal|tmux|\bpane\b|subagent|agent-?(browser|team)|shell|终端/ },
  { id: "web",      zh: "浏览器与联网", en: "Web & browser", re: /browser|chrome|\bcdp\b|web-?(access|search|fetch)|scrape|crawl|search|transcript|youtube|wechat|网页|浏览器|联网|抓取|搜索|公众号/ },
  { id: "docs",     zh: "文档与办公", en: "Documents & office", re: /docx|\bword\b|\bpdf\b|pptx|xlsx|excel|markdown|markitdo|mineru|\bocr\b|spreadsheet|document|文档|表格|转换|办公/ },
  { id: "design",   zh: "设计与视觉", en: "Design & visuals", re: /design|\bui\b|\bppt\b|slide|illustration|visual|figma|\bcss\b|infographic|poster|html|设计|排版|插画|视觉|幻灯/ },
  { id: "writing",  zh: "写作与内容", en: "Writing & content", re: /writ|humaniz|article|blog|copy|translat|edit|polish|review-panel|文章|写作|润色|文案|翻译/ },
  { id: "code",     zh: "开发与代码", en: "Code & dev", re: /\bcode\b|\bdev\b|\bgit\b|github|\btest|debug|refactor|frontend|\bapi\b|\bsdk\b|plugin|skill-creator|simplif|security|lint|build|代码|开发|调试|前端/ },
  { id: "finance",  zh: "金融与交易", en: "Finance & trading", re: /trade|trading|okx|crypto|market|earn|stock|portfolio|finance|bot|交易|行情|理财|量化/ },
  { id: "legal",    zh: "法律与合规", en: "Legal & compliance", re: /legal|\blaw\b|\bcase\b|court|contract|litigation|法律|案件|合同|法规|诉讼|律师/ },
];
export const OTHER = { id: "other", zh: "其他", en: "Other" };
export const REMOVED = { id: "removed", zh: "已卸载 / 内置", en: "Removed / built-in" };

export function categorize(name, description, overrides) {
  const o = overrides?.[name];
  if (o) { const hit = CATEGORIES.find((c) => c.id === o); return hit ? { id: hit.id, zh: hit.zh, en: hit.en } : { id: `custom:${o}`, zh: o, en: o }; }
  const bare = name.includes(":") ? name.split(":").pop() : name;
  for (const text of [bare.toLowerCase(), String(description ?? "").toLowerCase()]) {
    for (const c of CATEGORIES) if (c.re.test(text)) return { id: c.id, zh: c.zh, en: c.en };
  }
  return OTHER;
}

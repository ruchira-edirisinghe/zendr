// A copy of mods/review-file/lang.js (mods can't import from each other's folders): keep the two the same.
// What a file is: its language (for the status bar and the language picker), the grammar the
// editor colours it with, and a file-type icon in its own colour, like VS Code's Seti icons.
// Detection goes: the exact file name, the extension (longest first, so "d.ts" beats "ts"),
// then the content (a #! line, an editor modeline, or a telling first line).
// VS Code's installed extensions can add languages and file associations (mods/vscode writes
// them to vscode/languages.json; loadExtras() reads it).
import { readTextFile, appHome } from "herdr";

// The Seti palette: readable on dark and light themes alike.
export const SETI = {
  blue: "#519aba", green: "#8dc149", yellow: "#cbcb41", orange: "#e37933", red: "#cc3e44",
  purple: "#a074c4", pink: "#f55385", grey: "#6d8086", white: "#d4d7d6", teal: "#3fb6a8", brown: "#b8835a",
};
const C = SETI;
const icon = name => `mods/review-file/icons/${name}.svg`;

// editor: the grammar the built-in editor knows (syntect's names or extensions). Languages it
// has no grammar for borrow a close one (TypeScript reads as JavaScript, Kotlin as Scala).
const TABLE = [
  ["javascript", "JavaScript", "js mjs cjs", "", "js", "js", C.yellow],
  ["javascriptreact", "JavaScript JSX", "jsx", "", "js", "react", C.blue],
  ["typescript", "TypeScript", "ts mts cts", "", "js", "ts", C.blue],
  ["typescriptreact", "TypeScript JSX", "tsx", "", "js", "react", C.blue],
  ["json", "JSON", "json json5 webmanifest map", ".prettierrc .babelrc .eslintrc", "json", "braces", C.yellow],
  ["jsonc", "JSON with Comments", "jsonc code-workspace", "tsconfig.json jsconfig.json .vscode/settings.json .vscode/launch.json .vscode/tasks.json .vscode/extensions.json devcontainer.json", "json", "braces", C.yellow],
  ["markdown", "Markdown", "md markdown mdx mkd", "", "markdown", "markdown", C.blue],
  ["html", "HTML", "html htm xhtml", "", "html", "html", C.orange],
  ["css", "CSS", "css", "", "css", "css", C.blue],
  ["scss", "SCSS", "scss sass", "", "css", "css", C.pink],
  ["less", "Less", "less", "", "css", "css", C.blue],
  ["python", "Python", "py pyw pyi", "", "py", "python", C.blue],
  ["rust", "Rust", "rs", "", "rs", "rust", C.orange],
  ["go", "Go", "go", "", "go", "go", C.teal],
  ["c", "C", "c h", "", "c", "c", C.blue],
  ["cpp", "C++", "cpp cc cxx c++ hpp hh hxx h++ inl ipp", "", "cpp", "cpp", C.blue],
  ["csharp", "C#", "cs csx", "", "cs", "csharp", C.blue],
  ["java", "Java", "java", "", "java", "java", C.red],
  ["kotlin", "Kotlin", "kt kts", "", "scala", "kotlin", C.orange],
  ["swift", "Swift", "swift", "", "rs", "swift", C.orange],
  ["scala", "Scala", "scala sc sbt", "", "scala", "code", C.red],
  ["dart", "Dart", "dart", "", "java", "code", C.blue],
  ["ruby", "Ruby", "rb rake gemspec erb", "Gemfile Rakefile Podfile Vagrantfile", "rb", "ruby", C.red],
  ["php", "PHP", "php phtml", "", "php", "php", C.purple],
  ["lua", "Lua", "lua", "", "lua", "lua", C.blue],
  ["perl", "Perl", "pl pm", "", "pl", "code", C.blue],
  ["r", "R", "r rmd", "", "r", "code", C.blue],
  ["haskell", "Haskell", "hs lhs", "", "hs", "code", C.purple],
  ["clojure", "Clojure", "clj cljs cljc edn", "", "clj", "code", C.green],
  ["erlang", "Erlang", "erl hrl", "", "erl", "code", C.red],
  ["elixir", "Elixir", "ex exs", "", "rb", "code", C.purple],
  ["ocaml", "OCaml", "ml mli", "", "ml", "code", C.orange],
  ["zig", "Zig", "zig zon", "", "rs", "code", C.orange],
  ["shellscript", "Shell", "sh bash zsh fish ksh", ".bashrc .bash_profile .zshrc .zprofile .profile .envrc", "sh", "terminal", C.green],
  ["powershell", "PowerShell", "ps1 psm1 psd1", "", "sh", "terminal", C.blue],
  ["bat", "Batch", "bat cmd", "", "bat", "terminal", C.green],
  ["sql", "SQL", "sql psql mysql", "", "sql", "database", C.pink],
  ["yaml", "YAML", "yml yaml", ".clang-format .clangd", "yaml", "yaml", C.purple],
  ["toml", "TOML", "toml", "", "yaml", "gear", C.grey],
  ["ini", "INI", "ini cfg conf properties editorconfig", ".editorconfig .npmrc .gitconfig", "yaml", "gear", C.grey],
  ["xml", "XML", "xml xsd xsl xslt csproj vbproj fsproj props targets xaml resx plist nuspec", "", "xml", "code", C.orange],
  ["svg", "SVG", "svg", "", "xml", "svg", C.yellow],
  ["vue", "Vue", "vue", "", "html", "vue", C.green],
  ["svelte", "Svelte", "svelte", "", "html", "svelte", C.orange],
  ["graphql", "GraphQL", "graphql gql", "", "js", "code", C.pink],
  ["proto", "Protocol Buffers", "proto", "", "java", "code", C.blue],
  ["dockerfile", "Dockerfile", "dockerfile containerfile", "Dockerfile Containerfile", "sh", "docker", C.blue],
  ["makefile", "Makefile", "mk mak", "Makefile GNUmakefile makefile", "make", "gear", C.orange],
  ["cmake", "CMake", "cmake", "CMakeLists.txt", "sh", "gear", C.blue],
  ["nix", "Nix", "nix", "", "sh", "gear", C.blue],
  ["terraform", "Terraform", "tf tfvars hcl", "", "rb", "code", C.purple],
  ["latex", "LaTeX", "tex ltx sty cls", "", "tex", "text", C.green],
  ["diff", "Diff", "diff patch rej", "", "diff", "diff", C.orange],
  ["dotenv", "Environment", "env", ".env .env.local .env.example .env.development .env.production .env.test", "sh", "env", C.yellow],
  ["ignore", "Ignore list", "gitignore dockerignore npmignore prettierignore eslintignore", ".gitignore .dockerignore .npmignore .prettierignore .eslintignore .ignore", "sh", "git", C.orange],
  ["git", "Git config", "gitattributes gitmodules", ".gitattributes .gitmodules .git-blame-ignore-revs .mailmap", "sh", "git", C.orange],
  ["csv", "CSV", "csv tsv", "", "", "text", C.green],
  ["log", "Log", "log", "", "", "text", C.grey],
  ["plaintext", "Plain Text", "txt text", "", "", "text", C.white],
];

const LANGS = new Map();
const BY_EXT = new Map(), BY_NAME = new Map();
function add([id, name, exts, files, editor, glyph, color], extra = {}) {
  const lang = { id, name, exts: exts ? exts.split(" ") : [], files: files ? files.split(" ") : [], editor, icon: icon(glyph), color, ...extra };
  LANGS.set(id, lang);
  for (const e of lang.exts) if (!BY_EXT.has(e)) BY_EXT.set(e, lang);
  for (const f of lang.files) if (!BY_NAME.has(f.toLowerCase())) BY_NAME.set(f.toLowerCase(), lang);
  return lang;
}
TABLE.forEach(row => add(row));
export const PLAIN = LANGS.get("plaintext");

// Files that aren't text, and names with their own icon.
const ICON_EXT = {
  image: "png jpg jpeg gif webp bmp ico icns tif tiff avif heic psd",
  font: "ttf otf woff woff2 eot",
  archive: "zip tar gz tgz bz2 xz 7z rar zst",
  pdf: "pdf",
  binary: "exe dll so dylib wasm bin o obj a lib pdb class jar",
  database: "db sqlite sqlite3",
};
const ICON_COLOR = { image: C.purple, font: C.red, archive: C.brown, pdf: C.red, binary: C.grey, database: C.pink };
const BY_ICON_EXT = new Map();
for (const [glyph, exts] of Object.entries(ICON_EXT)) for (const e of exts.split(" ")) BY_ICON_EXT.set(e, glyph);
const LOCKS = new Set("package-lock.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb cargo.lock gemfile.lock poetry.lock composer.lock pipfile.lock go.sum flake.lock".split(" "));
const PACKAGES = { "package.json": C.red, "cargo.toml": C.orange, "pyproject.toml": C.blue, "go.mod": C.teal, "composer.json": C.purple, "gemfile": C.red, "pubspec.yaml": C.blue, "deno.json": C.white };
const isTest = name => /(^|[._-])(test|spec)s?\.[a-z0-9]+$|^test_.*\.py$|_test\.(go|py|rs)$/i.test(name);

const baseName = path => String(path ?? "").split(/[\\/]/).pop();
const tail2 = path => String(path ?? "").split(/[\\/]/).slice(-2).join("/").toLowerCase();

// The language a path names, or null: exact names, then extensions (longest first).
function byPath(path) {
  const name = baseName(path), lower = name.toLowerCase();
  const exact = BY_NAME.get(tail2(path)) ?? BY_NAME.get(lower) ?? BY_NAME.get(name.toLowerCase());
  if (exact) return exact;
  if (/^\.env(\.|$)/i.test(name)) return LANGS.get("dotenv");
  if (/^(license|licence|copying|notice|authors|contributors)(\.(md|txt))?$/i.test(name)) return /\.md$/i.test(name) ? LANGS.get("markdown") : PLAIN;
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    if (BY_EXT.has(ext)) return BY_EXT.get(ext);
  }
  if (/^dockerfile\b|\.dockerfile$/i.test(name)) return LANGS.get("dockerfile");
  return null;
}

// The language the text says it is: #!, a modeline, or its first line.
const SHEBANG = { python: "python", node: "javascript", deno: "typescript", bun: "typescript", "ts-node": "typescript", bash: "shellscript", sh: "shellscript", zsh: "shellscript", fish: "shellscript", dash: "shellscript", ksh: "shellscript", pwsh: "powershell", ruby: "ruby", perl: "perl", php: "php", lua: "lua", rscript: "r" };
export function sniff(text) {
  if (!text) return null;
  const head = text.slice(0, 2000), first = head.split("\n", 1)[0];
  const bang = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?([\w.-]+)/.exec(first);
  if (bang) { const prog = bang[1].replace(/[\d.]+$/, "").toLowerCase(); if (SHEBANG[prog]) return LANGS.get(SHEBANG[prog]); }
  const mode = /-\*-\s*(?:mode:\s*)?([\w+#-]+)\s*;?.*?-\*-/i.exec(head) ?? /\bvim?:.*\b(?:ft|filetype)=([\w+#-]+)/.exec(head);
  if (mode) { const found = find(mode[1]); if (found) return found; }
  const start = head.trimStart();
  if (/^<\?php/.test(start)) return LANGS.get("php");
  if (/^<\?xml/.test(start)) return LANGS.get("xml");
  if (/^<!doctype html|^<html[\s>]/i.test(start)) return LANGS.get("html");
  if (/^<svg[\s>]/.test(start)) return LANGS.get("svg");
  if (/^(diff --git |--- a\/|Index: )/.test(start)) return LANGS.get("diff");
  if (/^[{[]/.test(start) && text.length < 200000) { try { JSON.parse(text); return LANGS.get("json"); } catch { /* not JSON */ } }
  return null;
}

// A language by its id, name, alias or extension (for modelines and the picker).
export function find(word) {
  const w = String(word ?? "").toLowerCase();
  if (!w) return null;
  if (LANGS.has(w)) return LANGS.get(w);
  for (const lang of LANGS.values()) if (lang.name.toLowerCase() === w || lang.aliases?.includes(w)) return lang;
  const ALIAS = { js: "javascript", ts: "typescript", py: "python", rb: "ruby", sh: "shellscript", shell: "shellscript", bash: "shellscript", zsh: "shellscript", ps: "powershell", pwsh: "powershell", "c++": "cpp", "c#": "csharp", cs: "csharp", md: "markdown", yml: "yaml", text: "plaintext", txt: "plaintext", docker: "dockerfile", make: "makefile", rs: "rust", golang: "go", jsx: "javascriptreact", tsx: "typescriptreact", kt: "kotlin", tex: "latex", env: "dotenv" };
  if (ALIAS[w]) return LANGS.get(ALIAS[w]);
  return BY_EXT.get(w) ?? null;
}

// The language of a file: the name, then (for names that say nothing) its text.
export function detect(path, text) {
  return byPath(path) ?? sniff(text) ?? PLAIN;
}

// Every language, by name, for the picker.
export function languages() {
  return [...LANGS.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A file's icon and colour, as VS Code's Seti theme draws them.
export function fileIcon(path) {
  const name = baseName(path), lower = name.toLowerCase();
  if (LOCKS.has(lower)) return { icon: icon("lock"), color: C.grey };
  if (PACKAGES[lower]) return { icon: icon("package"), color: PACKAGES[lower] };
  if (/^readme(\.|$)/i.test(name)) return { icon: icon("info"), color: C.blue };
  if (/^(license|licence|copying)(\.|$)/i.test(name)) return { icon: icon("license"), color: C.yellow };
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const glyph = BY_ICON_EXT.get(ext);
  if (glyph) return { icon: icon(glyph), color: ICON_COLOR[glyph] };
  const lang = byPath(path);
  if (lang && isTest(name)) return { icon: icon("test"), color: lang.color };
  if (lang) return { icon: lang.icon, color: lang.color };
  return { icon: icon("file"), color: C.grey };
}
export const folderIcon = (open) => icon(open ? "folder-open" : "folder");

// VS Code's languages (from installed extensions): new file associations, and languages
// Zendr doesn't know yet, shown by name (with a grammar only when the editor has one).
// Read once from vscode/languages.json, which mods/vscode writes when it's turned on.
let extrasLoaded = null;
export function loadExtras() {
  extrasLoaded ??= (async () => {
    const text = await readTextFile(`${appHome()}/vscode/languages.json`).catch(() => null);
    if (!text) return 0;
    let data;
    try { data = JSON.parse(text); } catch { return 0; }
    if (data?.enabled === false) return 0;
    let added = 0;
    for (const l of Array.isArray(data?.languages) ? data.languages : []) {
      if (!l || typeof l.id !== "string") continue;
      const id = l.id.slice(0, 80);
      let lang = LANGS.get(id);
      if (!lang) {
        const name = typeof l.name === "string" && l.name ? l.name.slice(0, 80) : id;
        lang = add([id, name, "", "", find(id)?.editor ?? id.toLowerCase(), "code", C.grey], { from: "vscode" });
      }
      for (const e of (Array.isArray(l.extensions) ? l.extensions : []).slice(0, 50)) {
        const ext = String(e).replace(/^\./, "").toLowerCase();
        if (ext && !BY_EXT.has(ext)) { BY_EXT.set(ext, lang); added++; }
      }
      for (const f of (Array.isArray(l.filenames) ? l.filenames : []).slice(0, 50)) {
        const key = String(f).toLowerCase();
        if (key && !BY_NAME.has(key)) { BY_NAME.set(key, lang); added++; }
      }
    }
    return added;
  })();
  return extrasLoaded;
}

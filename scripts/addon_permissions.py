#!/usr/bin/env python3
"""What each add-on in config/addons needs, read from its code, kept in catalog.json.

    py scripts/addon_permissions.py           write each add-on's "permissions"
    py scripts/addon_permissions.py --check   fail if an add-on uses more than it declares

Zendr gives an add-on only what its catalog entry declares, and Settings → Add-ons shows
it before the add-on is turned on (app/src/addon_grants.rs). The permissions:

  exec       run programs (herdr's exec(), and commands that start one: argv)
  network    reach the network (fetch, WebSocket)
  read       read files outside the add-on's own folder (readTextFile, watchFolder)
  write      write files outside its data folder (writeTextFile)
  terminals  read and drive terminals through the core (hc())
"""

import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "addons")
CATALOG = os.path.join(ROOT, "catalog.json")
ORDER = ["exec", "network", "read", "write", "terminals"]

# A call of the function itself, not a method of the same name (re.exec, el.write).
def call(name):
    return re.compile(r"(?<![.\w$])" + name + r"\s*\(")

PATTERNS = {
    "exec": [call("exec")],
    "network": [call("fetch"), re.compile(r"\bnew\s+WebSocket\b"), re.compile(r"""exec\(\s*["'`](curl|wget)\b""")],
    "read": [call("readTextFile"), call("watchFolder")],
    "write": [call("writeTextFile")],
    "terminals": [call("hc"), re.compile(r"""exec\(\s*["'`]hc["'`]""")],
}


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(^|[^:\\])//[^\n]*", r"\1", src)


def scan(addon):
    found = set()
    for base, _, files in os.walk(os.path.join(ROOT, addon, "mods")):
        if os.sep + "vendor" in base or "/vendor" in base:
            continue
        for name in files:
            if not name.endswith((".js", ".mjs")):
                continue
            with open(os.path.join(base, name), encoding="utf-8") as f:
                src = strip_comments(f.read())
            for perm, patterns in PATTERNS.items():
                if any(p.search(src) for p in patterns):
                    found.add(perm)
    return [p for p in ORDER if p in found]


def main():
    check = "--check" in sys.argv[1:]
    with open(CATALOG, encoding="utf-8") as f:
        catalog = json.load(f)
    bad = []
    for a in catalog["addons"]:
        needs = scan(a["id"])
        if check:
            missing = [p for p in needs if p not in a.get("permissions", [])]
            if missing:
                bad.append(f"{a['id']}: uses {', '.join(missing)} but doesn't declare it")
        else:
            a["permissions"] = needs
    if check:
        if bad:
            sys.exit("\n".join(bad))
        print(f"{len(catalog['addons'])} add-ons declare what they use")
        return
    with open(CATALOG, "w", encoding="utf-8", newline="\n") as f:
        json.dump(catalog, f, indent=1, ensure_ascii=False)
        f.write("\n")
    for a in catalog["addons"]:
        print(f"{a['id']:18} {', '.join(a['permissions']) or '(nothing)'}")


if __name__ == "__main__":
    main()

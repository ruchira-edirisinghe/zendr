//! What an add-on may do. Zendr's own mods may do everything; an add-on (a mod folder Settings
//! → Add-ons copied in, marked `.zendr-addon`) gets what its catalog entry declares
//! (`permissions`, kept honest by scripts/addon_permissions.py --check), narrowed to what the
//! person agreed to when they turned it on (settings.json `addon_permissions.<id>`).

use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Grant {
    /// Run programs: `exec`, and commands that start one (`argv`).
    pub exec: bool,
    /// Reach the network.
    pub network: bool,
    /// Read files outside its own folders.
    pub read: bool,
    /// Write files outside its data folder.
    pub write: bool,
    /// Read and drive terminals through the core (`hc`).
    pub terminals: bool,
}

impl Grant {
    pub const ALL: Grant = Grant { exec: true, network: true, read: true, write: true, terminals: true };

    fn from_list(list: &Value) -> Option<Grant> {
        let list = list.as_array()?;
        let has = |p: &str| list.iter().any(|v| v.as_str() == Some(p));
        Some(Grant { exec: has("exec"), network: has("network"), read: has("read"), write: has("write"), terminals: has("terminals") })
    }

    fn and(self, o: Grant) -> Grant {
        Grant { exec: self.exec && o.exec, network: self.network && o.network, read: self.read && o.read, write: self.write && o.write, terminals: self.terminals && o.terminals }
    }
}

fn read_json(p: PathBuf) -> Value {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null)
}

fn catalog() -> Value {
    read_json(crate::mods::app_dir().join("addons").join("catalog.json"))
}

/// The add-on a mod came from, if it came from one: its folder's marker, or the catalog
/// naming it (so an add-on that deletes its marker is still one).
pub fn addon_of(mod_name: &str) -> Option<String> {
    if mod_name.is_empty() || mod_name.contains(['/', '\\']) || mod_name.starts_with('.') {
        return None;
    }
    let marker = crate::mods::app_dir().join("mods").join(mod_name).join(".zendr-addon");
    let marked = std::fs::read_to_string(marker).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    marked.or_else(|| listed_in(&catalog(), mod_name))
}

fn listed_in(catalog: &Value, mod_name: &str) -> Option<String> {
    catalog["addons"].as_array()?.iter()
        .find(|a| a["mods"].as_array().is_some_and(|m| m.iter().any(|m| m.as_str() == Some(mod_name))))
        .and_then(|a| a["id"].as_str().map(str::to_owned))
}

/// None: not an add-on, so it may do everything.
pub fn for_mod(mod_name: &str) -> Option<Grant> {
    let id = addon_of(mod_name)?;
    Some(resolve(&id, &catalog(), &read_json(crate::settings::path())))
}

/// Where no add-on writes, whatever it was given: the mods themselves, the add-ons and their
/// catalog, and settings.json (which holds what each add-on may do).
pub fn never_written(app: &Path) -> Vec<PathBuf> {
    vec![app.join("mods"), app.join("addons"), app.join("settings.json"), app.join("keys.json")]
}

fn resolve(id: &str, catalog: &Value, settings: &Value) -> Grant {
    let entry = catalog["addons"].as_array().into_iter().flatten().find(|a| a["id"].as_str() == Some(id));
    let declared = match entry {
        // An add-on the catalog doesn't know: nothing.
        None => Grant::default(),
        // A catalog from before permissions: as before.
        Some(a) if a.get("permissions").is_none() => Grant::ALL,
        Some(a) => Grant::from_list(&a["permissions"]).unwrap_or_default(),
    };
    // Turned on before Zendr asked: what it declares.
    let approved = settings.get("addon_permissions").and_then(|p| p.get(id)).and_then(Grant::from_list).unwrap_or(declared);
    declared.and(approved)
}

/// Whether `path` is inside one of `roots`, by its words alone: `..` never is.
pub fn inside(path: &str, roots: &[PathBuf]) -> bool {
    let p = Path::new(path);
    if !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    let norm = |p: &Path| {
        let s = p.to_string_lossy().replace('\\', "/");
        let s = s.trim_end_matches('/').to_owned();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    let path = norm(p);
    roots.iter().map(|r| norm(r)).any(|root| path == root || path.starts_with(&format!("{root}/")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_addon_gets_what_it_declares_and_was_allowed() {
        let catalog = json!({ "addons": [
            { "id": "a", "permissions": ["exec", "read"] },
            { "id": "none", "permissions": [] },
            { "id": "old" },
        ] });
        let read_exec = Grant { exec: true, read: true, ..Default::default() };
        assert_eq!(resolve("a", &catalog, &json!({})), read_exec);
        assert_eq!(resolve("a", &catalog, &json!({ "addon_permissions": { "a": ["read"] } })), Grant { read: true, ..Default::default() });
        // Asking for more than the catalog declares gets no more.
        assert_eq!(resolve("a", &catalog, &json!({ "addon_permissions": { "a": ["exec", "read", "network"] } })), read_exec);
        assert_eq!(resolve("none", &catalog, &json!({})), Grant::default());
        assert_eq!(resolve("old", &catalog, &json!({})), Grant::ALL);
        assert_eq!(resolve("gone", &catalog, &json!({})), Grant::default());
    }

    #[test]
    fn the_catalog_says_which_mods_are_addons() {
        let catalog = json!({ "addons": [{ "id": "pack", "mods": ["pack-a", "pack-b"] }] });
        assert_eq!(listed_in(&catalog, "pack-b").as_deref(), Some("pack"));
        assert_eq!(listed_in(&catalog, "hub"), None);
    }

    /// scripts/addon_permissions.py writes these from each add-on's code; --check keeps them true.
    #[test]
    fn every_shipped_addon_declares_what_it_may_do() {
        let catalog: Value = serde_json::from_str(include_str!("../../config/addons/catalog.json")).unwrap();
        let known = ["exec", "network", "read", "write", "terminals"];
        for a in catalog["addons"].as_array().unwrap() {
            let list = a["permissions"].as_array().unwrap_or_else(|| panic!("{} has no permissions", a["id"]));
            assert!(list.iter().all(|p| known.contains(&p.as_str().unwrap_or_default())), "{}: {list:?}", a["id"]);
        }
    }

    #[test]
    fn inside_its_folders_only() {
        let root = if cfg!(windows) { PathBuf::from(r"C:\Users\me\.config\herdr-app\mods\x") } else { PathBuf::from("/home/me/.config/herdr-app/mods/x") };
        let roots = [root.clone()];
        let base = root.to_string_lossy().replace('\\', "/");
        assert!(inside(&format!("{base}/main.js"), &roots));
        assert!(inside(&base, &roots));
        assert!(!inside(&format!("{base}/../y/main.js"), &roots));
        assert!(!inside(&format!("{base}-evil/main.js"), &roots));
        assert!(!inside("main.js", &roots));
        if cfg!(windows) {
            assert!(inside(r"c:\users\ME\.config\herdr-app\mods\x\a.json", &roots));
        }
    }
}

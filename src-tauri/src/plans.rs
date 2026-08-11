//! Service plans: the running order an operator builds before a service.
//!
//! A plan holds *references* rather than copies — song 42 of "Євангельські
//! пісні", John 3:16-18, that clip — so a song corrected on Saturday night is
//! corrected in Sunday's plan too. Resolving a reference back into something
//! projectable is the frontend's job; this only remembers what was chosen and
//! in what order.
//!
//! Everything lives in one `plans.json` rather than a file per plan. A plan is
//! a few dozen short entries, and one file means listing them is a single read
//! and reordering them can never half-succeed.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::paths::ensure_dir;

const MANIFEST: &str = "plans.json";

/// One item in a running order.
///
/// `kind` says which library it came from and `ref_` how to find it there; the
/// shape of the reference differs per kind, so it travels as free-form JSON
/// that only the frontend interprets. `label` is what was on screen when it
/// was added, kept so a plan still reads sensibly when the thing it points at
/// has been deleted from under it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub note: String,
    /// Folded shut, hiding what is under it. Only meaningful on a folder, and
    /// saved with the plan: somebody who folds the announcements away expects
    /// them to stay away next Sunday too.
    #[serde(default)]
    pub collapsed: bool,
    /// 0 for a line of the running order, 1 for something tucked under the
    /// line above it — the readings that belong to a sermon, say. Only one
    /// level deep: a service is a list with a few things grouped, not a tree.
    #[serde(default)]
    pub depth: u8,
    /// How long this item is expected to take, in minutes. 0 means nobody has
    /// said — it is left out of the running times rather than counted as
    /// instant.
    #[serde(default)]
    pub minutes: u32,
    #[serde(rename = "ref")]
    pub ref_: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub entries: Vec<PlanEntry>,
    /// When the service starts, as "HH:MM". Empty means the plan is only a
    /// running order, and the items show their own length instead of a clock.
    #[serde(default)]
    pub starts_at: String,
    /// Epoch milliseconds, so the list can put the most recently touched plan
    /// at the top — which is nearly always the one wanted again.
    #[serde(default)]
    pub updated_ms: u64,
}

type Manifest = BTreeMap<String, Plan>;

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST)
}

fn read_manifest(dir: &Path) -> Manifest {
    fs::read_to_string(manifest_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<()> {
    ensure_dir(dir)?;
    let path = manifest_path(dir);
    // Written beside and renamed over, so a crash mid-write cannot leave a
    // half-serialised plan where a service's running order used to be.
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_string_pretty(manifest)?)?;
    fs::rename(&temp, &path)?;
    Ok(())
}

/// Every saved plan, most recently touched first.
pub fn list(dir: &Path) -> Result<Vec<Plan>> {
    let mut out: Vec<Plan> = read_manifest(dir).into_values().collect();
    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Writes a plan, creating it if its id is new. Returns it as stored, with the
/// timestamp this save stamped on it.
pub fn save(dir: &Path, mut plan: Plan) -> Result<Plan> {
    if plan.id.trim().is_empty() {
        return Err(AppError::msg("a plan needs an id"));
    }
    if plan.name.trim().is_empty() {
        return Err(AppError::msg("a plan needs a name"));
    }
    plan.name = plan.name.trim().to_string();
    plan.updated_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut manifest = read_manifest(dir);
    manifest.insert(plan.id.clone(), plan.clone());
    write_manifest(dir, &manifest)?;
    Ok(plan)
}

pub fn remove(dir: &Path, id: &str) -> Result<()> {
    let mut manifest = read_manifest(dir);
    if manifest.remove(id).is_none() {
        return Err(AppError::msg(format!("plan \"{id}\" does not exist")));
    }
    write_manifest(dir, &manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "lyricverse-plans-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::remove_dir_all(&dir).ok();
        ensure_dir(&dir).expect("temp dir");
        dir
    }

    fn entry(id: &str, label: &str) -> PlanEntry {
        PlanEntry {
            minutes: 0,
            depth: 0,
            collapsed: false,
            id: id.into(),
            kind: "song".into(),
            label: label.into(),
            note: String::new(),
            ref_: serde_json::json!({ "songbook": "EvPisni", "songId": 42 }),
        }
    }

    #[test]
    fn saves_lists_and_removes_a_plan() {
        let dir = temp();
        let plan = Plan {
            starts_at: String::new(),
            id: "plan-1".into(),
            name: "  Sunday morning  ".into(),
            entries: vec![entry("e1", "Opening song")],
            updated_ms: 0,
        };

        let saved = save(&dir, plan).expect("save");
        // The name is tidied and the save is stamped, so the list can order by
        // what was touched last.
        assert_eq!(saved.name, "Sunday morning");
        assert!(saved.updated_ms > 0);

        let listed = list(&dir).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].entries.len(), 1);
        assert_eq!(listed[0].entries[0].label, "Opening song");
        // The reference travels untouched — only the frontend knows its shape.
        assert_eq!(listed[0].entries[0].ref_["songId"], 42);

        remove(&dir, "plan-1").expect("remove");
        assert!(list(&dir).expect("list").is_empty());
        assert!(remove(&dir, "plan-1").is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn saving_the_same_id_replaces_rather_than_duplicates() {
        let dir = temp();
        let plan = Plan {
            starts_at: String::new(),
            id: "plan-1".into(),
            name: "Draft".into(),
            entries: vec![entry("e1", "First")],
            updated_ms: 0,
        };
        save(&dir, plan.clone()).expect("save");
        save(&dir, Plan { name: "Final".into(), entries: vec![entry("e1", "First"), entry("e2", "Second")], ..plan })
            .expect("resave");

        let listed = list(&dir).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Final");
        assert_eq!(listed[0].entries.len(), 2);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_plan_needs_a_name() {
        let dir = temp();
        let plan = Plan {
            starts_at: String::new(),
            id: "p".into(),
            name: "   ".into(),
            entries: vec![],
            updated_ms: 0,
        };
        assert!(save(&dir, plan).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}

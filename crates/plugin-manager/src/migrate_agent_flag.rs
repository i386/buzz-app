//! TEMPORARY agents rename: remove after 2026-10-18 with the version-1 reader.
//! Version 2 distinguishes new Agents preferences from the retired v1 plugin.
use super::Registry;

pub(super) fn migrate(registry: &mut Registry) -> bool {
    if registry.version != 1 {
        return false;
    }
    registry.bundled_overrides.remove("buzz.agents");
    if let Some(enabled) = registry.bundled_overrides.remove("buzz.agents2") {
        registry
            .bundled_overrides
            .insert("buzz.agents".into(), enabled);
    }
    registry.version = 2;
    true
}

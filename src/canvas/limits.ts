// Canvas zoom limits. Mirror `graph::MIN_ZOOM` / `graph::MAX_ZOOM` in
// `src-tauri/src/graph/mod.rs`: Rust clamps a stored viewport into the same range, and resets
// a loaded one outside it, so the two must agree.

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

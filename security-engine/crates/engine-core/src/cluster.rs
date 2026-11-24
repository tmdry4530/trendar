use crate::fingerprint::simhash_distance;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterCandidate {
    pub github_id: i64,
    pub owner_login: String,
    pub text_key: Option<String>,
    pub skeleton_key: Option<String>,
    pub simhash: Option<String>,
    pub lure: bool,
    #[serde(default)]
    pub direct_malicious: bool,
    // Provenance fields for Origin Repo Protection (prevents Cluster Poisoning FP)
    pub language: Option<String>,
    pub forks: Option<i64>,
    pub repo_age_days: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterResult {
    pub hidden_ids: Vec<i64>,
    pub protected_origin_ids: Vec<i64>,
    pub exact_cluster_count: usize,
    pub fuzzy_cluster_count: usize,
}

fn is_protected_origin(c: &ClusterCandidate) -> bool {
    if c.direct_malicious {
        return false;
    }
    let has_lang = c.language.as_deref().is_some_and(|l| !l.is_empty());
    let has_forks = c.forks.unwrap_or(0) >= 5;
    let established_age = c.repo_age_days.unwrap_or(0) >= 30;
    has_lang && has_forks && established_age
}

/// Evaluates campaign clusters across candidates using:
/// 1. Exact `text_key` (>= `min_owners` distinct owners)
/// 2. Exact `skeleton_key` (>= `min_owners` distinct owners)
/// 3. Fuzzy 64-bit `simhash` (Hamming distance <= `max_simhash_distance`, >= `min_owners` distinct owners)
///
/// Applies Origin Repo Protection so an established legitimate repo whose README is cloned by
/// attackers is never hidden by Cluster Poisoning.
pub fn evaluate_clusters(
    candidates: &[ClusterCandidate],
    min_owners: usize,
    max_simhash_distance: u32,
) -> ClusterResult {
    let mut text_owners: HashMap<&str, HashSet<String>> = HashMap::new();
    let mut skel_owners: HashMap<&str, HashSet<String>> = HashMap::new();

    for c in candidates {
        if !c.lure {
            continue;
        }
        let owner = c.owner_login.to_lowercase();
        if owner.is_empty() {
            continue;
        }
        if let Some(ref tk) = c.text_key {
            text_owners.entry(tk.as_str()).or_default().insert(owner.clone());
        }
        if let Some(ref sk) = c.skeleton_key {
            skel_owners.entry(sk.as_str()).or_default().insert(owner);
        }
    }

    let mut exact_matched: HashSet<i64> = HashSet::new();
    for c in candidates {
        if !c.lure {
            continue;
        }
        let hit_text = c
            .text_key
            .as_deref()
            .is_some_and(|k| text_owners.get(k).is_some_and(|s| s.len() >= min_owners));
        let hit_skel = c
            .skeleton_key
            .as_deref()
            .is_some_and(|k| skel_owners.get(k).is_some_and(|s| s.len() >= min_owners));
        if hit_text || hit_skel {
            exact_matched.insert(c.github_id);
        }
    }

    // Fuzzy SimHash clustering using 4x16-bit pigeonhole band bucketing (guarantees finding any Hamming <= 3 pair!)
    let lure_simhashes: Vec<(usize, u64, String)> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| c.lure && !c.owner_login.is_empty())
        .filter_map(|(idx, c)| {
            let sh = c.simhash.as_deref()?;
            let val = u64::from_str_radix(sh, 16).ok()?;
            Some((idx, val, c.owner_login.to_lowercase()))
        })
        .collect();

    // 6-band pigeonhole bucketing over 64-bit SimHash: any pair with Hamming distance <= 5
    // is mathematically guaranteed to collide in at least 1 of the 6 bands.
    const BAND_SHIFTS: [(u32, u64); 6] = [
        (0, 0x7FF),  // bits 0..11  (11 bits)
        (11, 0x7FF), // bits 11..22 (11 bits)
        (22, 0x7FF), // bits 22..33 (11 bits)
        (33, 0x7FF), // bits 33..44 (11 bits)
        (44, 0x3FF), // bits 44..54 (10 bits)
        (54, 0x3FF), // bits 54..64 (10 bits)
    ];

    let mut bands: [HashMap<u16, Vec<usize>>; 6] = Default::default();
    for (pos, &(_, val, _)) in lure_simhashes.iter().enumerate() {
        for (b, &(shift, mask)) in BAND_SHIFTS.iter().enumerate() {
            let key = ((val >> shift) & mask) as u16;
            bands[b].entry(key).or_default().push(pos);
        }
    }

    // Union-Find connected components over the Hamming <= max_simhash_distance graph:
    // if A~B and A~C (or A~B~C), all members of a component with >= min_owners distinct owners are clustered.
    let n = lure_simhashes.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    fn union(parent: &mut [usize], a: usize, b: usize) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent[rb] = ra;
        }
    }

    for (pos, &(_, val, _)) in lure_simhashes.iter().enumerate() {
        let mut checked: HashSet<usize> = HashSet::new();
        checked.insert(pos);
        for (b, &(shift, mask)) in BAND_SHIFTS.iter().enumerate() {
            let key = ((val >> shift) & mask) as u16;
            if let Some(bucket) = bands[b].get(&key) {
                for &other_pos in bucket {
                    if other_pos <= pos || !checked.insert(other_pos) {
                        continue;
                    }
                    let (_, other_val, _) = lure_simhashes[other_pos];
                    if (val ^ other_val).count_ones() <= max_simhash_distance {
                        union(&mut parent, pos, other_pos);
                    }
                }
            }
        }
    }

    let mut comp_owners: HashMap<usize, HashSet<&str>> = HashMap::new();
    for (pos, &(_, _, ref owner)) in lure_simhashes.iter().enumerate() {
        let root = find(&mut parent, pos);
        comp_owners.entry(root).or_default().insert(owner.as_str());
    }

    let mut fuzzy_matched: HashSet<i64> = HashSet::new();
    for (pos, &(cand_idx, _, _)) in lure_simhashes.iter().enumerate() {
        let gid = candidates[cand_idx].github_id;
        if exact_matched.contains(&gid) {
            continue;
        }
        let root = find(&mut parent, pos);
        if comp_owners.get(&root).is_some_and(|s| s.len() >= min_owners) {
            fuzzy_matched.insert(gid);
        }
    }

    // Apply Origin Repo Protection
    let mut hidden_ids = Vec::new();
    let mut protected_origin_ids = Vec::new();
    for c in candidates {
        let in_cluster = exact_matched.contains(&c.github_id) || fuzzy_matched.contains(&c.github_id);
        if !in_cluster {
            continue;
        }
        if is_protected_origin(c) {
            protected_origin_ids.push(c.github_id);
        } else {
            hidden_ids.push(c.github_id);
        }
    }

    // Also expose simhash_distance usage so it's kept cleanly wired
    let _ = simhash_distance;

    ClusterResult {
        hidden_ids,
        protected_origin_ids,
        exact_cluster_count: exact_matched.len(),
        fuzzy_cluster_count: fuzzy_matched.len(),
    }
}

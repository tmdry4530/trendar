use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, OnceLock, RwLock};
use trendar_engine_core::{
    simhash_distance as core_simhash_distance, AnalysisReport, ClusterCandidate, ManifestInput,
    ReadmeTraits, RepoMeta, ScanOptions, SecurityEngine,
};

fn global_engine() -> &'static RwLock<Arc<SecurityEngine>> {
    static ENGINE: OnceLock<RwLock<Arc<SecurityEngine>>> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let eng = std::env::var("TRENDAR_RULES_DIR")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .and_then(|dir| SecurityEngine::from_rules_dir(dir).ok())
            .unwrap_or_else(|| {
                SecurityEngine::default_engine().expect("embedded ruleset must compile")
            });
        RwLock::new(Arc::new(eng))
    })
}

fn current_engine() -> Arc<SecurityEngine> {
    global_engine()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsEngineInfo {
    pub rule_version: u32,
    pub ruleset_id: String,
    pub ruleset_hash: String,
    pub backend: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsSignalHit {
    pub rule_id: String,
    pub category: String,
    pub weight: i32,
    pub detail: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsReadmeTraits {
    pub text_key: Option<String>,
    pub skeleton_key: Option<String>,
    pub simhash: Option<String>,
    pub lure: bool,
    pub archive_filehost_url: Option<String>,
    pub shortener_urls: Vec<String>,
    pub own_pages_lure: bool,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsAnalysisReport {
    pub verdict: String,
    pub risk_level: String,
    pub score: i32,
    pub rule_version: u32,
    pub ruleset_hash: String,
    pub evidence: Option<String>,
    pub signals: Vec<JsSignalHit>,
    pub traits: JsReadmeTraits,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct JsRepoMeta {
    pub owner: Option<String>,
    pub name: Option<String>,
    pub language: Option<String>,
    pub forks: Option<f64>,
    pub size: Option<f64>,
    pub stars: Option<f64>,
    pub homepage: Option<String>,
    pub description: Option<String>,
    pub topics: Option<Vec<String>>,
    pub owner_account_age_days: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsScanOptions {
    pub enable_multilingual: Option<bool>,
    pub enable_metadata_scoring: Option<bool>,
}

fn to_repo_meta(m: Option<JsRepoMeta>) -> Option<RepoMeta> {
    let m = m?;
    let to_i64 = |v: Option<f64>| -> Option<i64> {
        let f = v?;
        if f.is_finite() {
            Some(f as i64)
        } else {
            None
        }
    };
    Some(RepoMeta {
        owner: m.owner,
        name: m.name,
        language: m.language,
        forks: to_i64(m.forks),
        size: to_i64(m.size),
        stars: to_i64(m.stars),
        homepage: m.homepage,
        description: m.description,
        topics: m.topics.unwrap_or_default(),
        owner_account_age_days: to_i64(m.owner_account_age_days),
    })
}

fn to_scan_options(o: Option<JsScanOptions>) -> ScanOptions {
    let def = ScanOptions::default();
    match o {
        Some(opts) => ScanOptions {
            enable_multilingual: opts.enable_multilingual.unwrap_or(def.enable_multilingual),
            enable_metadata_scoring: opts
                .enable_metadata_scoring
                .unwrap_or(def.enable_metadata_scoring),
        },
        None => def,
    }
}

fn convert_traits(t: ReadmeTraits) -> JsReadmeTraits {
    JsReadmeTraits {
        text_key: t.text_key,
        skeleton_key: t.skeleton_key,
        simhash: t.simhash,
        lure: t.lure,
        archive_filehost_url: t.archive_filehost_url,
        shortener_urls: t.shortener_urls,
        own_pages_lure: t.own_pages_lure,
    }
}

fn convert_report(r: AnalysisReport) -> JsAnalysisReport {
    JsAnalysisReport {
        verdict: r.verdict,
        risk_level: r.risk_level,
        score: r.score,
        rule_version: r.rule_version,
        ruleset_hash: r.ruleset_hash,
        evidence: r.evidence,
        signals: r
            .signals
            .into_iter()
            .map(|s| JsSignalHit {
                rule_id: s.rule_id,
                category: s.category,
                weight: s.weight,
                detail: s.detail,
            })
            .collect(),
        traits: convert_traits(r.traits),
    }
}

#[napi]
pub fn engine_info() -> JsEngineInfo {
    let eng = current_engine();
    JsEngineInfo {
        rule_version: eng.rule_version(),
        ruleset_id: eng.rules().ruleset_id.clone(),
        ruleset_hash: eng.ruleset_hash().to_string(),
        backend: "rust-napi".to_string(),
    }
}

#[napi]
pub fn load_rules_dir(dir: String) -> Result<JsEngineInfo> {
    let eng = SecurityEngine::from_rules_dir(&dir)
        .map_err(|e| Error::from_reason(format!("failed to load ruleset: {e}")))?;
    let info = JsEngineInfo {
        rule_version: eng.rule_version(),
        ruleset_id: eng.rules().ruleset_id.clone(),
        ruleset_hash: eng.ruleset_hash().to_string(),
        backend: "rust-napi".to_string(),
    };
    let mut guard = global_engine()
        .write()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Arc::new(eng);
    Ok(info)
}

#[napi]
pub fn analyze_readme(
    text: Option<String>,
    meta: Option<JsRepoMeta>,
    options: Option<JsScanOptions>,
) -> Result<JsAnalysisReport> {
    let eng = current_engine();
    let repo_meta = to_repo_meta(meta);
    let scan_opts = to_scan_options(options);
    catch_unwind(AssertUnwindSafe(|| {
        convert_report(eng.analyze_readme(text.as_deref(), repo_meta.as_ref(), scan_opts))
    }))
    .map_err(|_| Error::from_reason("internal panic isolated in analyze_readme"))
}

pub struct AnalyzeAsyncTask {
    engine: Arc<SecurityEngine>,
    text: Option<String>,
    meta: Option<RepoMeta>,
    options: ScanOptions,
}

#[napi]
impl Task for AnalyzeAsyncTask {
    type Output = AnalysisReport;
    type JsValue = JsAnalysisReport;

    fn compute(&mut self) -> Result<Self::Output> {
        catch_unwind(AssertUnwindSafe(|| {
            self.engine
                .analyze_readme(self.text.as_deref(), self.meta.as_ref(), self.options)
        }))
        .map_err(|_| Error::from_reason("internal panic isolated in analyze_readme_async"))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(convert_report(output))
    }
}

/// Non-blocking async analysis executed on libuv worker threads so Express HTTP requests are never stalled.
#[napi]
pub fn analyze_readme_async(
    text: Option<String>,
    meta: Option<JsRepoMeta>,
    options: Option<JsScanOptions>,
) -> AsyncTask<AnalyzeAsyncTask> {
    AsyncTask::new(AnalyzeAsyncTask {
        engine: current_engine(),
        text,
        meta: to_repo_meta(meta),
        options: to_scan_options(options),
    })
}

#[napi]
pub fn extract_traits(
    text: Option<String>,
    owner: Option<String>,
    name: Option<String>,
) -> Result<JsReadmeTraits> {
    let eng = current_engine();
    catch_unwind(AssertUnwindSafe(|| {
        convert_traits(eng.extract_traits(text.as_deref(), owner.as_deref(), name.as_deref()))
    }))
    .map_err(|_| Error::from_reason("internal panic isolated in extract_traits"))
}

#[napi]
pub fn simhash_distance(a: String, b: String) -> Option<u32> {
    core_simhash_distance(&a, &b)
}

#[napi]
pub fn evaluate_clusters_json(candidates_json: String) -> Result<String> {
    let candidates: Vec<ClusterCandidate> = serde_json::from_str(&candidates_json)
        .map_err(|e| Error::from_reason(format!("invalid candidates JSON: {e}")))?;
    let eng = current_engine();
    let res = catch_unwind(AssertUnwindSafe(|| eng.evaluate_clusters(&candidates)))
        .map_err(|_| Error::from_reason("internal panic isolated in evaluate_clusters"))?;
    serde_json::to_string(&res)
        .map_err(|e| Error::from_reason(format!("failed serializing cluster result: {e}")))
}

#[napi]
pub fn analyze_manifest_json(input_json: String) -> Result<String> {
    let input: ManifestInput = serde_json::from_str(&input_json)
        .map_err(|e| Error::from_reason(format!("invalid manifest JSON: {e}")))?;
    let eng = current_engine();
    let res = catch_unwind(AssertUnwindSafe(|| eng.analyze_manifest(&input)))
        .map_err(|_| Error::from_reason("internal panic isolated in analyze_manifest"))?;
    serde_json::to_string(&res)
        .map_err(|e| Error::from_reason(format!("failed serializing manifest report: {e}")))
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

/// Manifest file name inside LPK archives
const MANIFEST_NAME: &str = "config.mlve";
const EXTRACTION_CACHE_VERSION: &str = "v2";
const EXTRACTION_CACHE_MARKER: &[u8] = b"rive2d-extraction-cache-v2";
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const MAX_ENTRY_SIZE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_SIZE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
struct ArchiveFingerprint {
    length: u64,
    modified_ns: Option<u128>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PersistentCacheEntry {
    length: u64,
    modified_ns: Option<u128>,
    key: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct PersistentCacheIndex {
    entries: HashMap<String, PersistentCacheEntry>,
}

struct RenameMapCacheEntry {
    fingerprint: ArchiveFingerprint,
    map: HashMap<String, String>,
}

type ExternalConfigCacheValue = (Option<ArchiveFingerprint>, ExternalConfig);

static RENAME_MAP_CACHE: OnceLock<Mutex<HashMap<String, RenameMapCacheEntry>>> = OnceLock::new();
static EXTRACTION_CACHE_PATHS: OnceLock<Mutex<HashMap<String, (ArchiveFingerprint, PathBuf)>>> =
    OnceLock::new();
static EXTRACTION_INDEX_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static EXTERNAL_CONFIG_CACHE: OnceLock<Mutex<HashMap<String, ExternalConfigCacheValue>>> =
    OnceLock::new();

/// Return the virtual model entry used when an LPK is loaded without extraction.
///
/// The returned path is an absolute filesystem-looking path whose prefix is the
/// source `.lpk` file. It is resolved by the `model://` protocol, not by the OS.
pub fn direct_model_path(lpk_path: &str) -> Result<String, String> {
    let mut archive = open_archive(lpk_path)?;
    let manifest = read_manifest(&mut archive);

    let entry = match manifest {
        Some(ref manifest) => encrypted_model_info(lpk_path, &mut archive, manifest)?.0,
        None => regular_model_entry(&mut archive)?,
    };

    Ok(virtual_path(lpk_path, &entry))
}

/// Prepare the complete extracted asset cache for an LPK before the webview
/// starts loading the model. This keeps decryption and archive traversal out
/// of the motion/texture request path.
pub fn prepare_model_assets(path: &str) -> Result<(), String> {
    let lpk_path = split_virtual_path(path)
        .map(|(archive, _)| archive.to_string())
        .or_else(|| {
            Path::new(path)
                .extension()
                .and_then(|extension| extension.to_str())
                .filter(|extension| extension.eq_ignore_ascii_case("lpk"))
                .map(|_| path.to_string())
        });
    if let Some(lpk_path) = lpk_path {
        ensure_extraction_cache(&lpk_path).map(|_| ())
    } else {
        Ok(())
    }
}

/// Read a file from a virtual path such as `/tmp/model.lpk/model.model3.json`.
/// No archive contents are written to disk.
pub fn read_virtual_asset(path: &str) -> Result<Vec<u8>, String> {
    let (lpk_path, entry) = split_virtual_path(path).ok_or("Not an LPK virtual path")?;

    // Use the complete extraction cache in every build. The model path remains
    // virtual and the cache is keyed by the archive content fingerprint.
    if let Ok(cache_dir) = ensure_extraction_cache(lpk_path) {
        let cached = cache_entry_path(&cache_dir, entry)?;
        if cached.is_file() {
            return std::fs::read(cached).map_err(|e| e.to_string());
        }
    }

    if let Some(preview) = workshop_preview_file(lpk_path) {
        let preview_name = format!(
            "__workshop_preview__.{}",
            preview
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("png")
        );
        if entry == preview_name {
            return std::fs::read(preview).map_err(|e| e.to_string());
        }
    }
    let mut archive = open_archive(lpk_path)?;
    let manifest = read_manifest(&mut archive);

    let data = match manifest {
        Some(ref manifest) => {
            read_encrypted_virtual_asset(lpk_path, entry, &mut archive, manifest)?
        }
        None => read_archive_entry(&mut archive, entry)?,
    };
    Ok(data)
}

fn extraction_cache_root() -> PathBuf {
    if let Some(path) = std::env::var_os("XDG_CACHE_HOME") {
        return PathBuf::from(path).join("rive2d/lpk");
    }
    if let Some(path) = std::env::var_os("HOME") {
        return PathBuf::from(path).join(".cache/rive2d/lpk");
    }
    std::env::temp_dir().join("rive2d-lpk-cache")
}

fn cache_entry_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("Unsafe cached asset path: {}", relative.display()));
    }
    let path = root.join(relative);
    if !path.starts_with(root) {
        return Err(format!(
            "Cached asset escapes destination: {}",
            relative.display()
        ));
    }
    Ok(path)
}

fn write_cached_asset(root: &Path, relative: &str, data: &[u8]) -> Result<(), String> {
    let path = cache_entry_path(root, relative)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, data).map_err(|e| e.to_string())
}

fn marker_path(root: &Path) -> PathBuf {
    root.join(".complete")
}

fn cache_is_complete(root: &Path) -> bool {
    std::fs::read(marker_path(root))
        .map(|data| data == EXTRACTION_CACHE_MARKER)
        .unwrap_or(false)
}

fn extraction_index_path(root: &Path) -> PathBuf {
    root.join("index.json")
}

fn read_persistent_cache_index(root: &Path) -> PersistentCacheIndex {
    std::fs::read(extraction_index_path(root))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

fn write_persistent_cache_index(root: &Path, index: &PersistentCacheIndex) {
    let path = extraction_index_path(root);
    let temporary = root.join(".index.json.tmp");
    let Ok(data) = serde_json::to_vec(index) else {
        return;
    };
    if std::fs::write(&temporary, data).is_ok() {
        let _ = std::fs::rename(temporary, path);
    }
}

fn remember_persistent_cache(
    root: &Path,
    lpk_path: &str,
    fingerprint: ArchiveFingerprint,
    key: &str,
) {
    let lock = EXTRACTION_INDEX_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };
    let mut index = read_persistent_cache_index(root);
    index.entries.insert(
        lpk_path.to_string(),
        PersistentCacheEntry {
            length: fingerprint.length,
            modified_ns: fingerprint.modified_ns,
            key: key.to_string(),
        },
    );
    write_persistent_cache_index(root, &index);
}

fn ensure_extraction_cache(lpk_path: &str) -> Result<PathBuf, String> {
    let fingerprint = archive_fingerprint(lpk_path)?;
    let cache_paths = EXTRACTION_CACHE_PATHS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache_paths.lock() {
        if let Some((cached_fingerprint, destination)) = cache.get(lpk_path) {
            if *cached_fingerprint == fingerprint && cache_is_complete(destination) {
                return Ok(destination.clone());
            }
        }
    }

    let root = extraction_cache_root();
    if let Ok(_guard) = EXTRACTION_INDEX_LOCK.get_or_init(|| Mutex::new(())).lock() {
        let index = read_persistent_cache_index(&root);
        if let Some(entry) = index.entries.get(lpk_path) {
            if entry.length == fingerprint.length && entry.modified_ns == fingerprint.modified_ns {
                let destination = root.join(&entry.key);
                if cache_is_complete(&destination) {
                    if let Ok(mut cache) = cache_paths.lock() {
                        cache.insert(lpk_path.to_string(), (fingerprint, destination.clone()));
                    }
                    return Ok(destination);
                }
            }
        }
    }

    // The source is hashed only when the persistent metadata index misses. The
    // hash keeps stale extractions from being reused after a Workshop file
    // changes while avoiding a full archive read on normal restarts.
    let source = std::fs::read(lpk_path).map_err(|e| e.to_string())?;
    let key = format!("{}-{:x}", EXTRACTION_CACHE_VERSION, md5::compute(&source));
    let destination = root.join(&key);
    if cache_is_complete(&destination) {
        remember_persistent_cache(&root, lpk_path, fingerprint, &key);
        if let Ok(mut cache) = cache_paths.lock() {
            cache.insert(lpk_path.to_string(), (fingerprint, destination.clone()));
        }
        return Ok(destination);
    }

    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let temporary = root.join(format!(".{}.tmp-{}", key, std::process::id()));
    if temporary.exists() {
        std::fs::remove_dir_all(&temporary).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&temporary).map_err(|e| e.to_string())?;

    let result = (|| {
        let mut archive = open_archive(lpk_path)?;
        let manifest = read_manifest(&mut archive);
        match manifest {
            Some(ref manifest) => {
                extract_encrypted_archive(lpk_path, &mut archive, manifest, &temporary)?
            }
            None => extract_regular_archive(&mut archive, &temporary)?,
        }
        if let Some(preview) = workshop_preview_file(lpk_path) {
            let extension = preview
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("png")
                .to_string();
            let data = std::fs::read(&preview).map_err(|e| e.to_string())?;
            write_cached_asset(
                &temporary,
                &format!("__workshop_preview__.{}", extension),
                &data,
            )?;
        }
        std::fs::write(marker_path(&temporary), EXTRACTION_CACHE_MARKER)
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })();

    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }

    if destination.exists() {
        let _ = std::fs::remove_dir_all(&temporary);
    } else if let Err(error) = std::fs::rename(&temporary, &destination) {
        let _ = std::fs::remove_dir_all(&temporary);
        if !cache_is_complete(&destination) {
            return Err(error.to_string());
        }
    }
    if let Ok(mut cache) = cache_paths.lock() {
        cache.insert(lpk_path.to_string(), (fingerprint, destination.clone()));
    }
    remember_persistent_cache(&root, lpk_path, fingerprint, &key);
    Ok(destination)
}

/// Return whether a virtual asset is already available in the complete cache.
/// The protocol uses this to skip compatibility JSON rewriting for prepared
/// LPK assets.
pub fn is_cached_virtual_asset(path: &str) -> bool {
    let Some((lpk_path, entry)) = split_virtual_path(path) else {
        return false;
    };
    let Ok(cache_dir) = ensure_extraction_cache(lpk_path) else {
        return false;
    };
    cache_entry_path(&cache_dir, entry)
        .map(|cached| cached.is_file())
        .unwrap_or(false)
}

/// Apply compatibility fixes once while building the extraction cache. The
/// WebView should receive stable cached bytes instead of reparsing every JSON
/// request in the Tauri protocol handler.
fn preprocess_cached_asset(name: &str, data: Vec<u8>) -> Vec<u8> {
    if !name.to_ascii_lowercase().ends_with(".json") {
        return data;
    }
    let Ok(text) = std::str::from_utf8(&data) else {
        return data;
    };
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(text) else {
        return data;
    };
    let mut patched_any = false;
    let lower_name = name.to_ascii_lowercase();

    if lower_name.ends_with(".model3.json") {
        if json.get("FileReferences").is_some() && json.get("Groups").is_none() {
            json["Groups"] = serde_json::json!([]);
            patched_any = true;
        }
        if let Some(textures) = json
            .pointer_mut("/FileReferences/Textures")
            .and_then(|value| value.as_array_mut())
        {
            let before = textures.len();
            textures.retain(|value| value.as_str().is_none_or(|item| !item.is_empty()));
            if textures.len() != before {
                patched_any = true;
            }
        }
    }

    if json
        .get("Meta")
        .and_then(|meta| meta.get("TotalPointCount"))
        .is_some()
        && json
            .get("Curves")
            .and_then(|curves| curves.as_array())
            .is_some()
    {
        let mut total_points = 0u64;
        let mut total_segments = 0u64;
        if let Some(curves) = json.get("Curves").and_then(|value| value.as_array()) {
            for curve in curves {
                let Some(segments) = curve.get("Segments").and_then(|value| value.as_array())
                else {
                    continue;
                };
                if segments.len() < 2 {
                    continue;
                }
                total_points += 1;
                let mut index = 2;
                while index < segments.len() {
                    let segment_type = segments[index].as_f64().unwrap_or(-1.0) as i64;
                    match segment_type {
                        0 | 2 | 3 => {
                            total_points += 1;
                            total_segments += 1;
                            index += 3;
                        }
                        1 => {
                            total_points += 3;
                            total_segments += 1;
                            index += 7;
                        }
                        _ => break,
                    }
                }
            }
        }
        json["Meta"]["TotalPointCount"] = serde_json::json!(total_points);
        json["Meta"]["TotalSegmentCount"] = serde_json::json!(total_segments);
        patched_any = true;
    }

    if patched_any {
        serde_json::to_vec(&json).unwrap_or(data)
    } else {
        data
    }
}

fn extract_regular_archive(
    archive: &mut zip::ZipArchive<std::fs::File>,
    destination: &Path,
) -> Result<(), String> {
    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|file| file.name().to_string())
        })
        .collect();
    for name in names {
        if name.ends_with('/') {
            continue;
        }
        let data = preprocess_cached_asset(&name, read_archive_entry(archive, &name)?);
        write_cached_asset(destination, &name, &data)?;
    }
    Ok(())
}

fn extract_encrypted_archive(
    lpk_path: &str,
    archive: &mut zip::ZipArchive<std::fs::File>,
    manifest: &MlveManifest,
    destination: &Path,
) -> Result<(), String> {
    let rename_map = cached_encrypted_rename_map(lpk_path, archive, manifest)?;
    let manifest_hash = format!("{:x}", md5::compute(MANIFEST_NAME.as_bytes()));
    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|file| file.name().to_string())
        })
        .collect();

    for name in names {
        if name.ends_with('/')
            || name == MANIFEST_NAME
            || name == manifest_hash
            || name == format!("{}.bin", manifest_hash)
        {
            continue;
        }
        let output_name = rename_map.get(&name).map(String::as_str).unwrap_or(&name);
        let data = preprocess_cached_asset(
            output_name,
            read_encrypted_entry(lpk_path, archive, manifest, &name)?,
        );
        write_cached_asset(destination, output_name, &data)?;
    }

    // Expose the encrypted costume descriptor through its generated model
    // filename, with hashed references rewritten to extracted names.
    let (model_name, costume_entry) = encrypted_model_info(lpk_path, archive, manifest)?;
    let mut model = String::from_utf8(read_encrypted_entry(
        lpk_path,
        archive,
        manifest,
        &costume_entry,
    )?)
    .map_err(|e| e.to_string())?;
    for (old_name, new_name) in rename_map {
        model = model.replace(&old_name, &new_name);
    }
    let model = preprocess_cached_asset(&model_name, model.into_bytes());
    write_cached_asset(destination, &model_name, &model)?;
    Ok(())
}

/// Return the Workshop cover as another virtual asset when the LPK has one.
pub fn workshop_preview_path(model_path: &str) -> Option<String> {
    let (lpk_path, _) = split_virtual_path(model_path)?;
    let preview = workshop_preview_file(lpk_path)?;
    let extension = preview.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return None;
    }
    Some(virtual_path(
        lpk_path,
        &format!("__workshop_preview__.{}", extension),
    ))
}

fn workshop_preview_file(lpk_path: &str) -> Option<PathBuf> {
    let archive_path = Path::new(lpk_path);
    let parent = archive_path.parent()?;
    let config_path = parent.join("config.json");
    let config = std::fs::read_to_string(config_path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&config).ok()?;
    let preview_file = config.get("previewFile")?.as_str()?;
    if preview_file.is_empty() {
        return None;
    }
    let parent = parent.canonicalize().ok()?;
    let preview = parent.join(preview_file).canonicalize().ok()?;
    if !preview.starts_with(&parent) || !preview.is_file() {
        return None;
    }
    Some(preview)
}

/// Split a virtual path at the first `.lpk/` boundary.
pub fn split_virtual_path(path: &str) -> Option<(&str, &str)> {
    let marker = ".lpk/";
    let index = path.find(marker)?;
    let lpk_end = index + ".lpk".len();
    let lpk_path = &path[..lpk_end];
    let entry = &path[lpk_end + 1..];
    if Path::new(lpk_path).is_absolute() && !entry.is_empty() {
        Some((lpk_path, entry))
    } else {
        None
    }
}

pub fn virtual_path(lpk_path: &str, entry: &str) -> String {
    format!("{}/{}", lpk_path.trim_end_matches('/'), entry)
}

pub fn join_virtual_path(model_path: &str, relative: &str) -> Option<String> {
    let (lpk_path, entry) = split_virtual_path(model_path)?;
    let parent = Path::new(entry).parent()?.to_string_lossy();
    let joined = if parent == "." {
        PathBuf::from(relative)
    } else {
        Path::new(parent.as_ref()).join(relative)
    };
    let joined = joined.to_string_lossy().replace('\\', "/");
    if joined.starts_with('/') || joined.split('/').any(|part| part == "..") {
        return None;
    }
    Some(virtual_path(lpk_path, &joined))
}

fn open_archive(lpk_path: &str) -> Result<zip::ZipArchive<std::fs::File>, String> {
    let file = std::fs::File::open(lpk_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    validate_archive(&mut archive)?;
    Ok(archive)
}

fn regular_model_entry<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Result<String, String> {
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = file.name().to_string();
        if name.ends_with(".model3.json") || name.ends_with(".model.json") {
            return Ok(name);
        }
    }
    Err("No .model3.json or .model.json found in archive".to_string())
}

#[derive(Debug, Deserialize)]
struct MlveManifest {
    /// Format version, e.g. "STM_1_0", "STD_1_0", "STD_2_0"
    #[serde(rename = "type")]
    format_type: Option<String>,
    /// Whether files are encrypted
    encrypt: Option<String>,
    /// Model identifier (used in key derivation)
    id: Option<String>,
    /// Model name
    #[serde(default)]
    name: Option<String>,
    /// Character/costume list
    #[serde(default)]
    list: Vec<MlveCharacter>,
}

#[derive(Debug, Deserialize)]
struct MlveCharacter {
    #[allow(dead_code)]
    #[serde(default)]
    avatar: String,
    /// Costume entries
    #[serde(default)]
    costume: Vec<MlveCostume>,
}

#[derive(Debug, Deserialize)]
struct MlveCostume {
    #[allow(dead_code)]
    #[serde(default)]
    name: String,
    /// Path to the costume file in the archive (hashed name with .bin3/.bin)
    #[serde(default)]
    path: String,
}

/// External config.json that accompanies STM-format LPK files
#[derive(Clone, Debug, Deserialize, Default)]
struct ExternalConfig {
    #[serde(rename = "fileId", default)]
    file_id: String,
    #[serde(rename = "metaData", default)]
    meta_data: String,
}

/// Return the generated virtual descriptor name and its encrypted archive entry.
fn encrypted_model_info(
    lpk_path: &str,
    archive: &mut zip::ZipArchive<std::fs::File>,
    manifest: &MlveManifest,
) -> Result<(String, String), String> {
    let rename_map = cached_encrypted_rename_map(lpk_path, archive, manifest)?;
    for character in &manifest.list {
        for costume in &character.costume {
            if !rename_map.contains_key(&costume.path) {
                continue;
            }
            let data = read_encrypted_entry(lpk_path, archive, manifest, &costume.path)?;
            let text = std::str::from_utf8(&data).map_err(|e| e.to_string())?;
            let ext = if text.contains("\"FileReferences\"") || text.contains("\"Version\"") {
                "model3.json"
            } else {
                "model.json"
            };
            let model_name = sanitize_filename(manifest.name.as_deref().unwrap_or("model"));
            let model_name = if model_name.is_empty() {
                "model"
            } else {
                &model_name
            };
            return Ok((format!("{}.{}", model_name, ext), costume.path.clone()));
        }
    }
    Err("No model descriptor found in encrypted LPK".to_string())
}

fn encrypted_rename_map(
    lpk_path: &str,
    archive: &mut zip::ZipArchive<std::fs::File>,
    manifest: &MlveManifest,
) -> Result<HashMap<String, String>, String> {
    let ext_config = if manifest
        .format_type
        .as_deref()
        .is_some_and(|format| format.starts_with("STM"))
    {
        load_external_config(lpk_path)
    } else {
        ExternalConfig::default()
    };
    let is_encrypted = manifest
        .encrypt
        .as_deref()
        .map(|value| value == "true")
        .unwrap_or(false);
    let is_stm = manifest
        .format_type
        .as_deref()
        .map(|format| format.starts_with("STM"))
        .unwrap_or(false);
    let model_id = manifest.id.as_deref().unwrap_or("");
    let manifest_hash = format!("{:x}", md5::compute(MANIFEST_NAME.as_bytes()));
    let mut rename_map = HashMap::new();

    let entry_names: Vec<String> = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|file| file.name().to_string())
        })
        .collect();
    for entry_name in entry_names {
        if entry_name == MANIFEST_NAME
            || entry_name == manifest_hash
            || entry_name == format!("{}.bin", manifest_hash)
            || !is_hashed_entry(&entry_name)
        {
            continue;
        }
        let mut data = read_archive_entry(archive, &entry_name)?;
        if is_encrypted {
            let key = derive_key(model_id, &ext_config, &entry_name, is_stm);
            decrypt_lcg_xor(&mut data, key);
        }
        let stem = entry_name
            .strip_suffix(".bin3")
            .or_else(|| entry_name.strip_suffix(".bin"))
            .unwrap_or(&entry_name);
        let output_name = format!("{}.{}", stem, detect_extension(&data));
        rename_map.insert(entry_name, output_name);
    }
    Ok(rename_map)
}

fn cached_encrypted_rename_map(
    lpk_path: &str,
    archive: &mut zip::ZipArchive<std::fs::File>,
    manifest: &MlveManifest,
) -> Result<HashMap<String, String>, String> {
    let fingerprint = archive_fingerprint(lpk_path)?;
    let cache = RENAME_MAP_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache.lock() {
        if let Some(entry) = cache.get(lpk_path) {
            if entry.fingerprint == fingerprint {
                return Ok(entry.map.clone());
            }
        }
    }

    let map = encrypted_rename_map(lpk_path, archive, manifest)?;
    if let Ok(mut cache) = cache.lock() {
        cache.insert(
            lpk_path.to_string(),
            RenameMapCacheEntry {
                fingerprint,
                map: map.clone(),
            },
        );
    }
    Ok(map)
}

fn archive_fingerprint(lpk_path: &str) -> Result<ArchiveFingerprint, String> {
    let metadata = std::fs::metadata(lpk_path).map_err(|e| e.to_string())?;
    Ok(ArchiveFingerprint {
        length: metadata.len(),
        modified_ns: metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos()),
    })
}

fn read_encrypted_entry(
    lpk_path: &str,
    archive: &mut zip::ZipArchive<std::fs::File>,
    manifest: &MlveManifest,
    entry_name: &str,
) -> Result<Vec<u8>, String> {
    let mut data = read_archive_entry(archive, entry_name)?;
    if manifest
        .encrypt
        .as_deref()
        .map(|value| value == "true")
        .unwrap_or(false)
        && is_hashed_entry(entry_name)
    {
        let is_stm = manifest
            .format_type
            .as_deref()
            .map(|format| format.starts_with("STM"))
            .unwrap_or(false);
        let ext_config = if is_stm {
            load_external_config(lpk_path)
        } else {
            ExternalConfig::default()
        };
        let key = derive_key(
            manifest.id.as_deref().unwrap_or(""),
            &ext_config,
            entry_name,
            is_stm,
        );
        decrypt_lcg_xor(&mut data, key);
    }
    Ok(data)
}

fn read_encrypted_virtual_asset(
    lpk_path: &str,
    requested_entry: &str,
    archive: &mut zip::ZipArchive<std::fs::File>,
    manifest: &MlveManifest,
) -> Result<Vec<u8>, String> {
    let (model_entry, costume_entry) = encrypted_model_info(lpk_path, archive, manifest)?;
    if requested_entry == model_entry {
        let mut content = String::from_utf8(read_encrypted_entry(
            lpk_path,
            archive,
            manifest,
            &costume_entry,
        )?)
        .map_err(|e| e.to_string())?;
        let rename_map = cached_encrypted_rename_map(lpk_path, archive, manifest)?;
        for (old_name, new_name) in rename_map {
            content = content.replace(&old_name, &new_name);
        }
        return Ok(content.into_bytes());
    }

    let rename_map = cached_encrypted_rename_map(lpk_path, archive, manifest)?;
    if let Some((archive_entry, _)) = rename_map
        .iter()
        .find(|(_, output_name)| output_name.as_str() == requested_entry)
    {
        return read_encrypted_entry(lpk_path, archive, manifest, archive_entry);
    }

    // Non-hashed entries are stored under their original names.
    read_encrypted_entry(lpk_path, archive, manifest, requested_entry)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn validate_archive<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Result<(), String> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "Archive contains too many entries (maximum {})",
            MAX_ARCHIVE_ENTRIES
        ));
    }

    let mut total_size = 0u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|e| e.to_string())?;
        if file.enclosed_name().is_none() {
            return Err(format!("Unsafe archive path: {}", file.name()));
        }
        if file.size() > MAX_ENTRY_SIZE {
            return Err(format!("Archive entry is too large: {}", file.name()));
        }
        total_size = total_size
            .checked_add(file.size())
            .ok_or("Archive size overflow")?;
        if total_size > MAX_TOTAL_SIZE {
            return Err("Archive uncompressed size is too large".to_string());
        }
    }
    Ok(())
}

/// Check if a ZIP entry name looks like an encrypted file (32 hex chars + .bin3 or .bin)
fn is_hashed_entry(name: &str) -> bool {
    let stem = name
        .strip_suffix(".bin3")
        .or_else(|| name.strip_suffix(".bin"));
    match stem {
        Some(s) => s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit()),
        None => false,
    }
}

/// Derive decryption key for an archive entry
fn derive_key(model_id: &str, ext_config: &ExternalConfig, entry_name: &str, is_stm: bool) -> i64 {
    let key_str = if is_stm {
        format!(
            "{}{}{}{}",
            model_id, ext_config.file_id, entry_name, ext_config.meta_data
        )
    } else {
        // STD format: id + entry_name
        format!("{}{}", model_id, entry_name)
    };
    java_hash_code(&key_str)
}

/// Detect file type by magic bytes and return appropriate extension
fn detect_extension(data: &[u8]) -> &'static str {
    if data.len() >= 4 {
        // PNG: 89 50 4E 47
        if data[..4] == [0x89, 0x50, 0x4E, 0x47] {
            return "png";
        }
        // MOC3: 4D 4F 43 33
        if data[..4] == [0x4D, 0x4F, 0x43, 0x33] {
            return "moc3";
        }
        // MOC (Cubism 2): 6D 6F 63
        if data[..3] == [0x6D, 0x6F, 0x63] {
            return "moc";
        }
        // RIFF (WAV): 52 49 46 46
        if data[..4] == [0x52, 0x49, 0x46, 0x46] {
            return "wav";
        }
        // OGG: 4F 67 67 53
        if data[..4] == [0x4F, 0x67, 0x67, 0x53] {
            return "ogg";
        }
        // MP3: FF FB or FF F3 or FF F2, or ID3 tag
        if (data[0] == 0xFF && (data[1] & 0xE0) == 0xE0) || (data[..3] == [0x49, 0x44, 0x33]) {
            return "mp3";
        }
        // JPEG: FF D8 FF
        if data[..3] == [0xFF, 0xD8, 0xFF] {
            return "jpg";
        }
    }
    // Try to detect text-based formats
    if let Ok(text) = std::str::from_utf8(data) {
        let trimmed = text.trim_start();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            return "json";
        }
        // Cubism 2 motion files start with "# Live2D Animator"
        if trimmed.starts_with("# Live2D") {
            return "mtn";
        }
    }
    "bin"
}

/// Sanitize a string for use as a filename
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Manifest reading
// ---------------------------------------------------------------------------

fn read_manifest(archive: &mut zip::ZipArchive<std::fs::File>) -> Option<MlveManifest> {
    // Try the plain name first
    if let Ok(data) = read_archive_entry(archive, MANIFEST_NAME) {
        if let Ok(manifest) = serde_json::from_slice::<MlveManifest>(&data) {
            return Some(manifest);
        }
    }

    // Try MD5-hashed name (with and without .bin extension)
    let hashed_name = format!("{:x}", md5::compute(MANIFEST_NAME.as_bytes()));
    for name in [format!("{}.bin", hashed_name), hashed_name] {
        if let Ok(data) = read_archive_entry(archive, &name) {
            if let Ok(manifest) = serde_json::from_slice::<MlveManifest>(&data) {
                return Some(manifest);
            }
        }
    }

    None
}

fn read_archive_entry(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
) -> Result<Vec<u8>, String> {
    let file = archive
        .by_name(name)
        .map_err(|e| format!("{}: {}", name, e))?;
    if file.size() > MAX_ENTRY_SIZE {
        return Err(format!("Archive entry is too large: {}", name));
    }
    let mut data = Vec::with_capacity(file.size() as usize);
    file.take(MAX_ENTRY_SIZE + 1)
        .read_to_end(&mut data)
        .map_err(|e| format!("Failed to read {}: {}", name, e))?;
    if data.len() as u64 > MAX_ENTRY_SIZE {
        return Err(format!("Archive entry is too large: {}", name));
    }
    Ok(data)
}

// ---------------------------------------------------------------------------
// External config.json loader (for STM format)
// ---------------------------------------------------------------------------

fn load_external_config(lpk_path: &str) -> ExternalConfig {
    let cache = EXTERNAL_CONFIG_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let lpk = Path::new(lpk_path);
    let config_path = lpk.parent().map(|parent| parent.join("config.json"));
    let fingerprint = config_path.as_ref().and_then(|path| {
        std::fs::metadata(path)
            .ok()
            .map(|metadata| ArchiveFingerprint {
                length: metadata.len(),
                modified_ns: metadata
                    .modified()
                    .ok()
                    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_nanos()),
            })
    });
    let key = lpk_path.to_string();

    if let Ok(cache) = cache.lock() {
        if let Some((cached_fingerprint, config)) = cache.get(&key) {
            if *cached_fingerprint == fingerprint {
                return config.clone();
            }
        }
    }

    let config = config_path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str::<ExternalConfig>(&data).ok());

    if config.is_some() {
        eprintln!("[rive2d] Loaded external config.json for STM decryption");
    } else {
        eprintln!(
            "[rive2d] Warning: No valid config.json found for STM format LPK, decryption may fail"
        );
    }
    let config = config.unwrap_or_default();
    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, (fingerprint, config.clone()));
    }
    config
}

// ---------------------------------------------------------------------------
// Java-style string hashCode → i64 (sign-extended)
// ---------------------------------------------------------------------------

/// Implements Java's `String.hashCode()` with sign extension to i64.
fn java_hash_code(s: &str) -> i64 {
    let mut hash: i32 = 0;
    for c in s.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(c as i32);
    }
    hash as i64 // sign-extends automatically in Rust
}

// ---------------------------------------------------------------------------
// LCG XOR cipher
// ---------------------------------------------------------------------------

/// Decrypt data using LCG-based XOR stream cipher.
///
/// The state is replaced by the shifted+masked output each iteration:
///   state = (65535 & ((2531011 + 214013 * state) >> 16))
///   byte ^= state & 0xFF
/// State resets to `key` at the start of every 1024-byte chunk.
fn decrypt_lcg_xor(data: &mut [u8], key: i64) {
    for chunk in data.chunks_mut(1024) {
        let mut k = key;
        for byte in chunk {
            k = (65535 & ((2531011 + 214013 * k) >> 16)) & 0xFFFFFFFF;
            *byte ^= k as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_java_hash_code() {
        assert_eq!(java_hash_code(""), 0);
        assert_eq!(java_hash_code("hello"), 99162322);
        assert_eq!(java_hash_code("Hello"), 69609650);
    }

    #[test]
    fn test_decrypt_roundtrip() {
        let original = b"Hello, Live2D!";
        let mut data = original.to_vec();
        let key = java_hash_code("test_key");
        decrypt_lcg_xor(&mut data, key);
        decrypt_lcg_xor(&mut data, key);
        assert_eq!(data, original);
    }

    #[test]
    fn encrypted_lpk_cannot_escape_destination() {
        use std::io::Write;
        use std::time::{SystemTime, UNIX_EPOCH};

        let root = std::env::temp_dir().join(format!(
            "rive2d-lpk-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("malicious.lpk");

        let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive_path).unwrap());
        writer
            .start_file(MANIFEST_NAME, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(br#"{"type":"STD_1_0","encrypt":"true","list":[]}"#)
            .unwrap();
        writer
            .start_file("../escaped.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"malicious").unwrap();
        writer.finish().unwrap();

        let error = direct_model_path(archive_path.to_str().unwrap()).unwrap_err();
        assert!(error.starts_with("Unsafe archive path:"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn test_md5_manifest_name() {
        let hash = format!("{:x}", md5::compute(MANIFEST_NAME.as_bytes()));
        assert_eq!(hash, "1d862f7d02e6008f4550188a31ca654f");
    }

    #[test]
    fn test_is_hashed_entry() {
        assert!(is_hashed_entry("38ce3c662ee7afaaecb6be49ee76d171.bin3"));
        assert!(is_hashed_entry("c6f00db7036d812b27ba3b7f291412c5.bin"));
        assert!(!is_hashed_entry("4a301072dec6b6a49050e5b294cd7983")); // no extension
        assert!(!is_hashed_entry("config.mlve"));
        assert!(!is_hashed_entry("model.model3.json"));
    }

    #[test]
    fn test_detect_extension() {
        assert_eq!(detect_extension(&[0x89, 0x50, 0x4E, 0x47, 0x00]), "png");
        assert_eq!(detect_extension(&[0x4D, 0x4F, 0x43, 0x33, 0x00]), "moc3");
        assert_eq!(detect_extension(b"{\"Version\":3}"), "json");
        assert_eq!(detect_extension(&[0x00, 0x01, 0x02, 0x03]), "bin");
    }

    #[test]
    fn preprocess_cached_motion_recalculates_curve_metadata() {
        let source = br#"{
            "Meta": {"TotalPointCount": 999, "TotalSegmentCount": 999},
            "Curves": [{"Segments": [0, 0, 0, 0, 0, 0, 0, 0]}]
        }"#;
        let processed = preprocess_cached_asset("motions/test.motion3.json", source.to_vec());
        let json: serde_json::Value = serde_json::from_slice(&processed).unwrap();
        assert_eq!(json["Meta"]["TotalPointCount"], 3);
        assert_eq!(json["Meta"]["TotalSegmentCount"], 2);
    }

    #[test]
    fn preprocess_cached_model_adds_groups_and_removes_empty_texture() {
        let source = br#"{
            "FileReferences": {"Textures": ["", "texture_00.png"]}
        }"#;
        let processed = preprocess_cached_asset("model.model3.json", source.to_vec());
        let json: serde_json::Value = serde_json::from_slice(&processed).unwrap();
        assert_eq!(json["Groups"], serde_json::json!([]));
        assert_eq!(
            json["FileReferences"]["Textures"],
            serde_json::json!(["texture_00.png"])
        );
    }

    #[test]
    fn direct_workshop_lpk_can_be_read_when_configured() {
        let Some(path) = std::env::var_os("RIVE2D_TEST_LPK") else {
            return;
        };
        let path = path.to_string_lossy();
        let model_path = direct_model_path(&path).unwrap();
        let model = read_virtual_asset(&model_path).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&model).unwrap();
        assert!(json.get("FileReferences").is_some() || json.get("model").is_some());

        let preview_path = workshop_preview_path(&model_path).unwrap();
        assert!(!read_virtual_asset(&preview_path).unwrap().is_empty());

        let texture = json
            .pointer("/FileReferences/Textures/0")
            .and_then(|value| value.as_str())
            .or_else(|| json.pointer("/textures/0").and_then(|value| value.as_str()));
        if let Some(texture) = texture {
            let texture_path = join_virtual_path(&model_path, texture).unwrap();
            assert!(!read_virtual_asset(&texture_path).unwrap().is_empty());
        }

        if cfg!(debug_assertions) {
            let cache = ensure_extraction_cache(&path).unwrap();
            assert!(cache_is_complete(&cache));
        }
    }
}

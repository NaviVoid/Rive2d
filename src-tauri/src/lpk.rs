use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// Manifest file name inside LPK archives
const MANIFEST_NAME: &str = "config.mlve";

/// Extract an LPK file to `dest_dir`, returning the path to the .model3.json/.model.json.
///
/// Handles both regular (unencrypted) LPK files and Live2DViewerEX-style
/// encrypted LPK files (STM_1_0 / STD_1_0 / STD_2_0 formats).
pub fn extract_lpk(dest_dir: &Path, lpk_path: &str) -> Result<String, String> {
    // Clean destination directory to avoid stale files from previous extractions
    if dest_dir.exists() {
        std::fs::remove_dir_all(dest_dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;

    let file = std::fs::File::open(lpk_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // Try to find the manifest (config.mlve or its MD5-hashed name)
    let manifest = read_manifest(&mut archive);

    match manifest {
        Some(manifest) => extract_encrypted_lpk(dest_dir, lpk_path, &mut archive, &manifest),
        None => extract_regular_lpk(dest_dir, &mut archive),
    }
}

// ---------------------------------------------------------------------------
// Regular (unencrypted) LPK
// ---------------------------------------------------------------------------

fn extract_regular_lpk(
    dest_dir: &Path,
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<String, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    archive.extract(dest_dir).map_err(|e| e.to_string())?;
    find_model_json(dest_dir)
        .ok_or_else(|| "No .model3.json or .model.json found in archive".to_string())
}

// ---------------------------------------------------------------------------
// Encrypted LPK (Live2DViewerEX)
// ---------------------------------------------------------------------------

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
#[derive(Debug, Deserialize, Default)]
struct ExternalConfig {
    #[serde(rename = "fileId", default)]
    file_id: String,
    #[serde(rename = "metaData", default)]
    meta_data: String,
}

fn extract_encrypted_lpk(
    dest_dir: &Path,
    lpk_path: &str,
    archive: &mut zip::ZipArchive<std::fs::File>,
    manifest: &MlveManifest,
) -> Result<String, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;

    let is_encrypted = manifest
        .encrypt
        .as_deref()
        .map(|s| s == "true")
        .unwrap_or(false);

    let is_stm = manifest
        .format_type
        .as_deref()
        .map(|t| t.starts_with("STM"))
        .unwrap_or(false);

    // Load external config.json for STM format
    let ext_config = if is_stm {
        load_external_config(lpk_path)
    } else {
        ExternalConfig::default()
    };

    let model_id = manifest.id.as_deref().unwrap_or("");

    // Collect all encrypted entry names from the archive
    let entry_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();

    // Decrypt all .bin3/.bin files and track renamed files
    let mut rename_map: HashMap<String, String> = HashMap::new();
    let manifest_hash = format!("{:x}", md5::compute(MANIFEST_NAME.as_bytes()));

    for entry_name in &entry_names {
        // Skip the manifest file
        if entry_name == MANIFEST_NAME
            || entry_name == &manifest_hash
            || entry_name == &format!("{}.bin", manifest_hash)
        {
            continue;
        }

        // Check if this is an encrypted entry (32 hex chars + .bin3 or .bin)
        let is_encrypted_entry = is_hashed_entry(entry_name);

        let data = read_archive_entry(archive, entry_name)?;

        let data = if is_encrypted && is_encrypted_entry {
            let key = derive_key(model_id, &ext_config, entry_name, is_stm);
            decrypt_lcg_xor(&data, key)
        } else {
            data
        };

        // Determine output filename based on file type detection
        let out_name = if is_encrypted_entry {
            let ext = detect_extension(&data);
            let stem = entry_name
                .strip_suffix(".bin3")
                .or_else(|| entry_name.strip_suffix(".bin"))
                .unwrap_or(entry_name);
            let new_name = format!("{}.{}", stem, ext);
            rename_map.insert(entry_name.clone(), new_name.clone());
            new_name
        } else {
            entry_name.clone()
        };

        let out_path = dest_dir.join(&out_name);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&out_path, &data).map_err(|e| e.to_string())?;
    }

    // Find the costume file (model descriptor) and save with correct extension
    let mut model_json_path = None;
    for character in &manifest.list {
        for costume in &character.costume {
            if let Some(renamed) = rename_map.get(&costume.path) {
                let src = dest_dir.join(renamed);
                if src.exists() {
                    // Read the model descriptor and rewrite file references
                    let mut content =
                        std::fs::read_to_string(&src).map_err(|e| e.to_string())?;
                    for (old_name, new_name) in &rename_map {
                        content = content.replace(old_name.as_str(), new_name.as_str());
                    }

                    // Detect Cubism version from content to use correct extension
                    // Cubism 4/3: has "Version" and "FileReferences"
                    // Cubism 2: has "model" and "textures"
                    let is_cubism3plus = content.contains("\"FileReferences\"")
                        || content.contains("\"Version\"");
                    let ext = if is_cubism3plus {
                        "model3.json"
                    } else {
                        "model.json"
                    };

                    let model_name = manifest
                        .name
                        .as_deref()
                        .unwrap_or("model");
                    let model_filename =
                        format!("{}.{}", sanitize_filename(model_name), ext);
                    let model_path = dest_dir.join(&model_filename);
                    std::fs::write(&model_path, &content).map_err(|e| e.to_string())?;

                    // Remove the original renamed file
                    std::fs::remove_file(&src).ok();

                    model_json_path =
                        Some(model_path.to_string_lossy().to_string());
                }
            }
        }
    }

    model_json_path.ok_or_else(|| "No model descriptor found in encrypted LPK".to_string())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
        if (data[0] == 0xFF && (data[1] & 0xE0) == 0xE0)
            || (data[..3] == [0x49, 0x44, 0x33])
        {
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
    let mut file = archive
        .by_name(name)
        .map_err(|e| format!("{}: {}", name, e))?;
    let mut data = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut data)
        .map_err(|e| format!("Failed to read {}: {}", name, e))?;
    Ok(data)
}

// ---------------------------------------------------------------------------
// External config.json loader (for STM format)
// ---------------------------------------------------------------------------

fn load_external_config(lpk_path: &str) -> ExternalConfig {
    let lpk = Path::new(lpk_path);
    if let Some(parent) = lpk.parent() {
        let config_path = parent.join("config.json");
        if config_path.exists() {
            if let Ok(data) = std::fs::read_to_string(&config_path) {
                if let Ok(config) = serde_json::from_str::<ExternalConfig>(&data) {
                    eprintln!("[rive2d] Loaded external config.json for STM decryption");
                    return config;
                }
            }
        }
    }
    eprintln!("[rive2d] Warning: No config.json found for STM format LPK, decryption may fail");
    ExternalConfig::default()
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
fn decrypt_lcg_xor(data: &[u8], key: i64) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());
    for chunk in data.chunks(1024) {
        let mut k = key;
        for &byte in chunk {
            k = (65535 & ((2531011 + 214013 * k) >> 16)) & 0xFFFFFFFF;
            result.push((k as u8) ^ byte);
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Model JSON finder (for regular LPK)
// ---------------------------------------------------------------------------

pub fn find_model_json(dir: &Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_model_json(&path) {
                return Some(found);
            }
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.ends_with(".model3.json") || name.ends_with(".model.json") {
                return Some(path.to_string_lossy().to_string());
            }
        }
    }
    None
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
        let key = java_hash_code("test_key");
        let encrypted = decrypt_lcg_xor(original, key);
        let decrypted = decrypt_lcg_xor(&encrypted, key);
        assert_eq!(decrypted, original);
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
}

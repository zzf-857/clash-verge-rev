use crate::{
    config::{IClashTemp, IProfiles, IVerge},
    constants::files::DNS_CONFIG,
    utils::dirs,
};
use anyhow::{Context as _, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Read as _,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RestoreMode {
    Full,
    #[default]
    CrossDevice,
}

type Files = BTreeMap<PathBuf, Vec<u8>>;
const ROOTS: [&str; 5] = [
    "profiles",
    dirs::PROFILE_YAML,
    dirs::CLASH_CONFIG,
    dirs::VERGE_CONFIG,
    DNS_CONFIG,
];

pub fn validate_filename(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name != "."
            && name != ".."
            && !name.contains(['/', '\\', ':', '\0', '?', '#', '%'])
            && !name.ends_with(['.', ' ']),
        "Invalid backup filename"
    );
    Ok(())
}

fn mapping(bytes: &[u8]) -> Result<serde_yaml_ng::Value> {
    let value: serde_yaml_ng::Value =
        serde_yaml_ng::from_slice(bytes).map_err(|_| anyhow::anyhow!("Backup contains invalid YAML"))?;
    ensure!(value.is_mapping(), "Backup configuration must be a YAML mapping");
    Ok(value)
}

fn read_archive(path: &Path) -> Result<Files> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path)?)?;
    ensure!(zip.len() <= 4096, "Backup contains too many entries");
    let mut files = Files::new();
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name().to_owned();
        ensure!(seen.insert(name.to_lowercase()), "Duplicate backup entry");
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            ensure!(
                kind == 0 || kind == 0o100000 || kind == 0o040000,
                "Linked or special backup entry rejected"
            );
        }
        if name == "profiles/" && entry.is_dir() {
            continue;
        }
        ensure!(!entry.is_dir(), "Nested backup directories are not supported");
        if let Some(file) = name.strip_prefix("profiles/") {
            validate_filename(file)?;
        } else {
            ensure!(ROOTS[1..].contains(&name.as_str()), "Unexpected backup entry");
        }
        total = total.checked_add(entry.size()).context("Backup size overflow")?;
        ensure!(total <= 256 * 1024 * 1024, "Backup exceeds 256 MiB");
        let mut bytes = Vec::new();
        (&mut entry).take(256 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() as u64 == entry.size(), "Invalid backup entry size");
        files.insert(PathBuf::from(name), bytes);
    }
    for name in [dirs::PROFILE_YAML, dirs::CLASH_CONFIG, dirs::VERGE_CONFIG] {
        mapping(
            files
                .get(Path::new(name))
                .context("Backup is missing a required configuration file")?,
        )?;
    }
    if let Some(bytes) = files.get(Path::new(DNS_CONFIG)) {
        mapping(bytes)?;
    }
    let index: IProfiles = serde_yaml_ng::from_slice(&files[Path::new(dirs::PROFILE_YAML)])
        .map_err(|_| anyhow::anyhow!("Invalid backup profile index"))?;
    let mut uids = HashSet::new();
    for item in index.items.iter().flatten() {
        let uid = item.uid.as_ref().context("Profile UID is missing")?;
        ensure!(uids.insert(uid.as_str()), "Duplicate profile UID");
        let file = item.file.as_ref().context("Indexed profile filename is missing")?;
        validate_filename(file)?;
        ensure!(
            files.contains_key(&Path::new("profiles").join(file.as_str())),
            "An indexed profile file is missing"
        );
    }
    if let Some(current) = &index.current {
        ensure!(uids.contains(current.as_str()), "Current profile is missing");
    }
    for item in index.items.iter().flatten() {
        if let Some(option) = &item.option {
            for uid in [
                &option.merge,
                &option.script,
                &option.rules,
                &option.proxies,
                &option.groups,
            ]
            .into_iter()
            .flatten()
            {
                ensure!(uids.contains(uid.as_str()), "Profile extension reference is missing");
            }
        }
    }
    for (name, bytes) in &files {
        if name.starts_with("profiles") && matches!(name.extension().and_then(|s| s.to_str()), Some("yaml" | "yml")) {
            // Rule/proxy extension files can also be sequences.
            serde_yaml_ng::from_slice::<serde_yaml_ng::Value>(bytes)
                .map_err(|_| anyhow::anyhow!("Invalid profile YAML in backup"))?;
        }
    }
    Ok(files)
}

fn check_portable(value: &serde_yaml_ng::Value, top_level: bool) -> Result<()> {
    match value {
        serde_yaml_ng::Value::Mapping(map) => {
            for (key, value) in map {
                let key = key.as_str().context("Non-string profile key cannot be migrated")?;
                ensure!(
                    !top_level
                        || matches!(
                            key,
                            "proxies" | "proxy-providers" | "proxy-groups" | "rule-providers" | "rules" | "payload"
                        ),
                    "Cross-device restore refused: profile or Merge keys outside subscriptions and rules require manual review"
                );
                ensure!(
                    !matches!(key, "interface-name" | "routing-mark"),
                    "Cross-device restore refused: device interface settings require review"
                );
                if key == "path" {
                    bail!(
                        "Cross-device restore refused: provider or external file paths require review on the source device"
                    );
                }
                check_portable(value, false)?;
            }
        }
        serde_yaml_ng::Value::Sequence(values) => {
            for value in values {
                check_portable(value, false)?;
            }
        }
        serde_yaml_ng::Value::String(value) => {
            ensure!(
                !value.starts_with(['/', '\\']) && !value.as_bytes().get(1).is_some_and(|b| *b == b':'),
                "Cross-device restore refused: absolute paths require review on the source device"
            );
        }
        serde_yaml_ng::Value::Tagged(_) => bail!("Cross-device restore refused: tagged YAML is unsupported"),
        _ => {}
    }
    Ok(())
}

fn snapshot_tree(root: &Path, relative: &Path, files: &mut Files) -> Result<()> {
    let path = root.join(relative);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        !metadata.file_type().is_symlink(),
        "Linked target configuration rejected"
    );
    if metadata.is_dir() {
        for entry in fs::read_dir(&path)? {
            snapshot_tree(root, &relative.join(entry?.file_name()), files)?;
        }
    } else {
        ensure!(metadata.is_file(), "Special target configuration rejected");
        files.insert(relative.to_path_buf(), fs::read(path)?);
    }
    Ok(())
}

fn snapshot(app: &Path) -> Result<Files> {
    let mut files = Files::new();
    for root in ROOTS {
        snapshot_tree(app, Path::new(root), &mut files)?;
    }
    Ok(files)
}

fn private_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub struct RestoreOutcome {
    pub recovery: PathBuf,
    pub profiles: IProfiles,
    pub verge: IVerge,
    pub clash: IClashTemp,
}

pub fn restore(app: &Path, archive: &Path, mode: RestoreMode) -> Result<RestoreOutcome> {
    restore_with(app, archive, mode, |_, _| Ok(()))
}

fn restore_with(
    app: &Path,
    archive: &Path,
    mode: RestoreMode,
    mut checkpoint: impl FnMut(&str, usize) -> Result<()>,
) -> Result<RestoreOutcome> {
    let lock_path = app.join(".restore.lock");
    let lock_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .context("Restore busy: another restore is running, or an interrupted restore needs inspection")?;
    let _lock_cleanup = scopeguard::guard((lock_file, lock_path), |(file, path)| {
        drop(file);
        let _ = fs::remove_file(path);
    });
    let mut files = read_archive(archive)?;
    let before = snapshot(app)?;
    let target_verge = before
        .get(Path::new(dirs::VERGE_CONFIG))
        .context("Target settings are missing")?;
    let target_verge = mapping(target_verge)?;
    let mut incoming_verge = mapping(&files[Path::new(dirs::VERGE_CONFIG)])?;
    for key in ["webdav_url", "webdav_username", "webdav_password"] {
        incoming_verge
            .as_mapping_mut()
            .context("Invalid Verge mapping")?
            .remove(serde_yaml_ng::Value::from(key));
        if let Some(value) = target_verge.get(key) {
            incoming_verge[key] = value.clone();
        }
    }
    files.insert(
        PathBuf::from(dirs::VERGE_CONFIG),
        serde_yaml_ng::to_string(&incoming_verge)?.into_bytes(),
    );
    if mode == RestoreMode::CrossDevice {
        let index: IProfiles = serde_yaml_ng::from_slice(&files[Path::new(dirs::PROFILE_YAML)])?;
        ensure!(
            !index
                .items
                .iter()
                .flatten()
                .any(|item| item.itype.as_deref() == Some("script")),
            "Cross-device restore refused: extension scripts require manual review"
        );
        for (path, bytes) in &files {
            if path.starts_with("profiles") {
                ensure!(
                    matches!(path.extension().and_then(|s| s.to_str()), Some("yaml" | "yml")),
                    "Cross-device restore refused: scripts or unknown profile files may inject device settings; review them on the source device first"
                );
                let value = serde_yaml_ng::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid profile YAML"))?;
                check_portable(&value, true)?;
            }
        }
        for root in [dirs::CLASH_CONFIG, dirs::VERGE_CONFIG, DNS_CONFIG] {
            files.remove(Path::new(root));
            if let Some(bytes) = before.get(Path::new(root)) {
                files.insert(PathBuf::from(root), bytes.clone());
            }
        }
    }
    let profiles = serde_yaml_ng::from_slice(&files[Path::new(dirs::PROFILE_YAML)])
        .map_err(|_| anyhow::anyhow!("Invalid profile index"))?;
    let verge = serde_yaml_ng::from_slice(&files[Path::new(dirs::VERGE_CONFIG)])
        .map_err(|_| anyhow::anyhow!("Invalid Verge settings"))?;
    let clash = IClashTemp(
        mapping(&files[Path::new(dirs::CLASH_CONFIG)])?
            .as_mapping()
            .context("Invalid Clash mapping")?
            .clone(),
    );
    let recovery = app.join(format!("restore-point-{}", nanoid::nanoid!()));
    private_dir(&recovery)?;
    let stage = recovery.join("stage");
    let original = recovery.join("original");
    let displaced = recovery.join("displaced");
    private_dir(&displaced)?;
    private_dir(&stage)?;
    private_dir(&original)?;
    private_dir(&original.join("profiles"))?;
    private_dir(&stage.join("profiles"))?;
    for (name, bytes) in &files {
        write_private(&stage.join(name), bytes)?;
    }
    fs::write(
        recovery.join("README.txt"),
        "Local restore point. Contains private target settings. Do not upload.\nAfter stopping the client, copy every item under original back to the application directory.\nAn absent optional dns_config.yaml in original means it must be removed from the application directory.\nThe running core is unchanged until the application restarts.\n",
    )?;
    for (name, bytes) in &before {
        let target = original.join(name);
        fs::create_dir_all(target.parent().context("Invalid recovery path")?)?;
        write_private(&target, bytes)?;
    }
    checkpoint("prepared", 0)?;
    ensure!(
        snapshot(app)? == before,
        "Restore conflict: configuration changed during staging; no files replaced"
    );
    let mut moved = Vec::new();
    let mut installed = Vec::new();
    let result = (|| -> Result<()> {
        for (i, root) in ROOTS.iter().enumerate() {
            checkpoint("commit", i)?;
            if app.join(root).exists() {
                fs::rename(app.join(root), displaced.join(root))?;
                moved.push(*root);
            }
            if stage.join(root).exists() {
                fs::rename(stage.join(root), app.join(root))?;
                installed.push(*root);
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        let rollback = (|| -> Result<()> {
            for (i, root) in installed.iter().rev().enumerate() {
                checkpoint("rollback", i)?;
                fs::rename(app.join(root), stage.join(root))?;
            }
            for root in moved.iter().rev() {
                fs::rename(displaced.join(root), app.join(root))?;
            }
            Ok(())
        })();
        if rollback.is_err() {
            bail!(
                "Restore failed and ROLLBACK FAILED. Keep the client running and recover files from {} before restarting",
                recovery.display()
            );
        }
        return Err(error.context("Restore failed; original configuration restored"));
    }
    Ok(RestoreOutcome {
        recovery,
        profiles,
        verge,
        clash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("restore-test-{}", nanoid::nanoid!()));
            private_dir(&root).unwrap();
            fs::create_dir(root.join("profiles")).unwrap();
            fs::write(root.join("profiles/old.yaml"), "rules: []\n").unwrap();
            fs::write(
                root.join(dirs::PROFILE_YAML),
                "current: old\nitems: [{uid: old, type: local, file: old.yaml}]\n",
            )
            .unwrap();
            fs::write(root.join(dirs::CLASH_CONFIG), "mixed-port: 17897\n").unwrap();
            fs::write(
                root.join(dirs::VERGE_CONFIG),
                "webdav_password: target-secret\nenable_system_proxy: false\n",
            )
            .unwrap();
            Self(root)
        }
        fn archive(&self, extra: &[(&str, &str)]) -> PathBuf {
            let path = self.0.join("incoming.zip");
            let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            for (name, text) in [
                (
                    dirs::PROFILE_YAML,
                    "current: new\nitems: [{uid: new, type: local, file: new.yaml}]\n",
                ),
                (dirs::CLASH_CONFIG, "mixed-port: 9999\n"),
                (
                    dirs::VERGE_CONFIG,
                    "webdav_password: source-secret\nenable_system_proxy: true\n",
                ),
                ("profiles/new.yaml", "proxy-groups: []\nrules: []\n"),
            ]
            .into_iter()
            .chain(extra.iter().copied())
            {
                zip.start_file(name, SimpleFileOptions::default()).unwrap();
                zip.write_all(text.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn full_restore_keeps_target_credentials_and_readable_recovery_point() {
        let fixture = Fixture::new();
        let before = snapshot(&fixture.0).unwrap();
        let archive = fixture.archive(&[]);
        let recovery = restore(&fixture.0, &archive, RestoreMode::Full).unwrap();
        assert_eq!(snapshot(&recovery.recovery.join("original")).unwrap(), before);
        let settings = fs::read_to_string(fixture.0.join(dirs::VERGE_CONFIG)).unwrap();
        assert!(settings.contains("target-secret"));
        assert!(!settings.contains("source-secret"));
        assert!(!fixture.0.join("profiles/old.yaml").exists());
        assert!(fixture.0.join("profiles/new.yaml").exists());
    }

    #[test]
    fn cross_device_preserves_network_settings_and_rejects_script_merge_and_path_injection() {
        let fixture = Fixture::new();
        let before = snapshot(&fixture.0).unwrap();
        let archive = fixture.archive(&[]);
        restore(&fixture.0, &archive, RestoreMode::CrossDevice).unwrap();
        for name in [dirs::CLASH_CONFIG, dirs::VERGE_CONFIG] {
            assert_eq!(fs::read(fixture.0.join(name)).unwrap(), before[Path::new(name)]);
        }
        for extra in [
            (
                "profiles/Script.js",
                "function main(c) { c.tun = {enable:true}; return c; }",
            ),
            ("profiles/Merge.yaml", "tun: {enable: true}\n"),
            (
                "profiles/Merge.yaml",
                "proxy-providers: {x: {path: /private/source.yaml}}\n",
            ),
        ] {
            let archive = fixture.archive(&[extra]);
            let before = snapshot(&fixture.0).unwrap();
            assert!(restore(&fixture.0, &archive, RestoreMode::CrossDevice).is_err());
            assert_eq!(snapshot(&fixture.0).unwrap(), before);
        }
    }

    #[test]
    fn dangerous_incomplete_and_corrupt_archives_do_not_modify_target() {
        let fixture = Fixture::new();
        let before = snapshot(&fixture.0).unwrap();
        for extra in [
            ("profiles/../escape", "x"),
            ("unexpected.yaml", "{}"),
            ("profiles/broken.yaml", "[broken"),
        ] {
            let archive = fixture.archive(&[extra]);
            assert!(restore(&fixture.0, &archive, RestoreMode::Full).is_err());
            assert_eq!(snapshot(&fixture.0).unwrap(), before);
        }
        let archive = fixture.archive(&[]);
        fs::write(&archive, b"not a zip").unwrap();
        assert!(restore(&fixture.0, &archive, RestoreMode::Full).is_err());
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        zip.start_file(dirs::VERGE_CONFIG, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
        assert!(restore(&fixture.0, &archive, RestoreMode::Full).is_err());
        assert_eq!(snapshot(&fixture.0).unwrap(), before);
    }

    #[test]
    fn missing_index_targets_and_extension_references_are_rejected() {
        let fixture = Fixture::new();
        let before = snapshot(&fixture.0).unwrap();
        for index in [
            "current: missing\nitems: []\n",
            "items: [{uid: missing, type: local, file: absent.yaml}]\n",
            "items: [{uid: new, type: local, file: new.yaml, option: {script: absent}}]\n",
        ] {
            let archive = fixture.0.join("invalid-index.zip");
            let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            for (name, bytes) in [
                (dirs::PROFILE_YAML, index),
                (dirs::CLASH_CONFIG, "{}"),
                (dirs::VERGE_CONFIG, "{}"),
                ("profiles/new.yaml", "{}"),
            ] {
                zip.start_file(name, SimpleFileOptions::default()).unwrap();
                zip.write_all(bytes.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
            assert!(restore(&fixture.0, &archive, RestoreMode::Full).is_err());
            assert_eq!(snapshot(&fixture.0).unwrap(), before);
        }
    }

    #[test]
    fn links_are_rejected_before_commit() {
        let fixture = Fixture::new();
        let archive = fixture.0.join("link.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        zip.add_symlink("profiles/link.yaml", "/outside", SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
        let before = snapshot(&fixture.0).unwrap();
        assert!(restore(&fixture.0, &archive, RestoreMode::Full).is_err());
        assert_eq!(snapshot(&fixture.0).unwrap(), before);
    }

    #[test]
    fn conflicts_abort_and_commit_failures_roll_back_every_replaced_file() {
        let fixture = Fixture::new();
        let archive = fixture.archive(&[]);
        let result = restore_with(&fixture.0, &archive, RestoreMode::Full, |phase, _| {
            if phase == "prepared" {
                fs::write(fixture.0.join(dirs::CLASH_CONFIG), "mixed-port: 17898\n")?;
            }
            Ok(())
        });
        assert!(result.err().unwrap().to_string().contains("conflict"));
        let before = snapshot(&fixture.0).unwrap();
        for fail_at in 0..ROOTS.len() {
            let result = restore_with(&fixture.0, &archive, RestoreMode::Full, |phase, index| {
                ensure!(phase != "commit" || index != fail_at, "Injected write failure");
                Ok(())
            });
            assert!(
                result
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("original configuration restored")
            );
            assert_eq!(snapshot(&fixture.0).unwrap(), before);
        }
    }

    #[test]
    fn simultaneous_restore_is_rejected_without_overwriting_first_transaction() {
        let fixture = Fixture::new();
        let archive = fixture.archive(&[]);
        restore_with(&fixture.0, &archive, RestoreMode::Full, |phase, _| {
            if phase == "prepared" {
                let error = restore(&fixture.0, &archive, RestoreMode::Full).err().unwrap();
                assert!(error.to_string().contains("Restore busy"));
            }
            Ok(())
        })
        .unwrap();
        assert!(fixture.0.join("profiles/new.yaml").exists());
        assert!(!fixture.0.join(".restore.lock").exists());
    }

    #[test]
    fn rollback_failure_is_distinct_and_retains_complete_original_files() {
        let fixture = Fixture::new();
        let before = snapshot(&fixture.0).unwrap();
        let archive = fixture.archive(&[]);
        let result = restore_with(&fixture.0, &archive, RestoreMode::Full, |phase, index| {
            ensure!(
                phase != "rollback" && !(phase == "commit" && index == 2),
                "Injected I/O failure"
            );
            Ok(())
        });
        assert!(result.err().unwrap().to_string().contains("ROLLBACK FAILED"));
        let recovery = fs::read_dir(&fixture.0)
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("restore-point-"))
            .unwrap()
            .path();
        assert_eq!(snapshot(&recovery.join("original")).unwrap(), before);
    }
}

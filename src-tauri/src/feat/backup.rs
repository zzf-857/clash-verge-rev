use crate::{
    config::Config,
    core::{
        backup,
        backup_restore::{self, RestoreMode},
    },
    process::AsyncHandler,
    utils::dirs::{PathBufExec as _, app_home_dir, local_backup_dir},
};
use anyhow::{Result, anyhow};
use chrono::Utc;
use clash_verge_logging::{Type, logging};
use reqwest_dav::list_cmd::ListFile;
use serde::Serialize;
use smartstring::alias::String;
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug, Serialize)]
pub struct LocalBackupFile {
    pub filename: String,
    pub path: String,
    pub last_modified: String,
    pub content_length: u64,
}

#[tracing::instrument(skip_all, level = "info")]
pub async fn create_backup_and_upload_webdav() -> Result<()> {
    let (file_name, temp_file_path) = backup::create_backup().await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to create backup: {err:#}");
        err
    })?;

    let _cleanup = scopeguard::guard(temp_file_path.clone(), |path| {
        let _ = std::fs::remove_file(path);
    });
    if let Err(err) = backup::WebDavClient::global()
        .upload(temp_file_path.clone(), file_name)
        .await
    {
        logging!(error, Type::Backup, "Failed to upload to WebDAV: {err:#}");
        backup::WebDavClient::global().reset();
        return Err(err);
    }

    if let Err(err) = temp_file_path.remove_if_exists().await {
        logging!(warn, Type::Backup, "Failed to remove temp file: {err:#}");
    }

    Ok(())
}

pub async fn list_wevdav_backup() -> Result<Vec<ListFile>> {
    backup::WebDavClient::global().list().await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to list WebDAV backup files: {err:#}");
        err
    })
}

pub async fn delete_webdav_backup(filename: String) -> Result<()> {
    let name = filename.to_string();
    backup::WebDavClient::global().delete(filename).await.map_err(|err| {
        logging!(
            error,
            Type::Backup,
            "Failed to delete WebDAV backup file {name}: {err:#}"
        );
        err
    })
}

#[tracing::instrument(skip_all, level = "info", fields(filename = %filename))]
pub async fn restore_webdav_backup(filename: String, mode: RestoreMode) -> Result<String> {
    backup_restore::validate_filename(&filename)?;
    let storage = std::env::temp_dir().join(format!("verge-restore-{}.zip", nanoid::nanoid!()));
    let cleanup = scopeguard::guard(storage.clone(), |path| {
        let _ = std::fs::remove_file(path);
    });
    backup::WebDavClient::global()
        .download(filename, storage.clone())
        .await?;
    let result = restore_staged_archive(storage, mode).await;
    drop(cleanup);
    result
}

async fn restore_staged_archive(archive: PathBuf, mode: RestoreMode) -> Result<String> {
    static RESTORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _restore = RESTORE_LOCK
        .try_lock()
        .map_err(|_| anyhow!("Another restore is in progress"))?;
    let _profile_write = crate::config::profiles::PROFILE_WRITE_LOCK.lock().await;
    let _config_write = Config::lock_config_write().await;
    let app = app_home_dir()?;
    Config::profiles()
        .await
        .with_data_modify(move |_previous| async move {
            let restored =
                AsyncHandler::spawn_blocking(move || backup_restore::restore(&app, &archive, mode)).await??;
            // Restart saves in-memory settings; publish validated data without applying network side effects.
            let clash = Config::clash().await;
            clash.edit_draft(|draft| *draft = restored.clash);
            clash.apply();
            let verge = Config::verge().await;
            verge.edit_draft(|draft| *draft = restored.verge);
            verge.apply();
            Ok((
                restored.profiles,
                restored.recovery.to_string_lossy().into_owned().into(),
            ))
        })
        .await
}

pub async fn create_local_backup() -> Result<()> {
    create_local_backup_with_namer(|name| name.to_string().into())
        .await
        .map(|_| ())
}

pub async fn create_local_backup_with_namer<F>(namer: F) -> Result<String>
where
    F: FnOnce(&str) -> String,
{
    let (file_name, temp_file_path) = backup::create_backup().await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to create local backup: {err:#}");
        err
    })?;

    let backup_dir = local_backup_dir()?;
    let final_name = namer(file_name.as_str());
    let target_path = backup_dir.join(final_name.as_str());

    if let Err(err) = move_file(temp_file_path.clone(), target_path.clone()).await {
        logging!(
            error,
            Type::Backup,
            "Failed to move local backup file to {}: {err:#}",
            target_path.display()
        );
        if let Err(clean_err) = temp_file_path.remove_if_exists().await {
            logging!(
                warn,
                Type::Backup,
                "Failed to remove temp backup file after move error: {clean_err:#}"
            );
        }
        return Err(err);
    }

    Ok(final_name)
}

#[tracing::instrument(skip_all, level = "info", fields(source = %source))]
pub async fn import_local_backup(source: String) -> Result<String> {
    let source_path = PathBuf::from(source.as_str());
    if !source_path.exists() {
        return Err(anyhow!("Backup file not found: {source}"));
    }
    if !source_path.is_file() {
        return Err(anyhow!("Backup path is not a file: {source}"));
    }

    let ext = source_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "zip" {
        return Err(anyhow!("Only .zip backup files are supported"));
    }

    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Invalid backup file name"))?;

    let backup_dir = local_backup_dir()?;
    let target_path = backup_dir.join(file_name);

    if target_path == source_path {
        return Ok(file_name.to_string().into());
    }

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    if target_path.exists() {
        return Err(anyhow!("Backup file already exists: {file_name}"));
    }

    fs::copy(&source_path, &target_path)
        .await
        .map_err(|err| anyhow!("Failed to import backup file: {err:#}"))?;

    Ok(file_name.to_string().into())
}

async fn move_file(from: PathBuf, to: PathBuf) -> Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).await?;
    }

    match fs::rename(&from, &to).await {
        Ok(_) => Ok(()),
        Err(rename_err) => {
            // Rename can fail across filesystems; fall back to copy then remove.
            logging!(
                warn,
                Type::Backup,
                "Failed to rename backup file directly, fallback to copy/remove: {rename_err}"
            );
            fs::copy(&from, &to)
                .await
                .map_err(|err| anyhow!("Failed to copy backup file: {err:#}"))?;
            fs::remove_file(&from)
                .await
                .map_err(|err| anyhow!("Failed to remove temp backup file: {err:#}"))?;
            Ok(())
        }
    }
}

pub async fn list_local_backup() -> Result<Vec<LocalBackupFile>> {
    let backup_dir = local_backup_dir()?;
    if !backup_dir.exists() {
        return Ok(vec![]);
    }

    let mut backups = Vec::new();
    let mut dir = fs::read_dir(&backup_dir).await?;
    while let Some(entry) = dir.next_entry().await? {
        let path = entry.path();
        let metadata = entry.metadata().await?;
        if !metadata.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name,
            None => continue,
        };
        let last_modified = metadata
            .modified()
            .map(|time| chrono::DateTime::<Utc>::from(time).to_rfc3339())
            .unwrap_or_default();
        backups.push(LocalBackupFile {
            filename: file_name.into(),
            path: path.to_string_lossy().into(),
            last_modified: last_modified.into(),
            content_length: metadata.len(),
        });
    }

    backups.sort_by(|a, b| b.filename.cmp(&a.filename));
    Ok(backups)
}

pub async fn delete_local_backup(filename: String) -> Result<()> {
    backup_restore::validate_filename(&filename)?;
    let backup_dir = local_backup_dir()?;
    let target_path = backup_dir.join(filename.as_str());
    if !target_path.exists() {
        logging!(debug, Type::Backup, "Local backup file not found: {}", filename);
        return Ok(());
    }
    target_path.remove_if_exists().await?;
    Ok(())
}

#[tracing::instrument(skip_all, level = "info", fields(filename = %filename))]
pub async fn restore_local_backup(filename: String, mode: RestoreMode) -> Result<String> {
    backup_restore::validate_filename(&filename)?;
    restore_staged_archive(local_backup_dir()?.join(filename.as_str()), mode).await
}

#[tracing::instrument(skip_all, level = "info", fields(filename = %filename, destination = %destination))]
pub async fn export_local_backup(filename: String, destination: String) -> Result<()> {
    backup_restore::validate_filename(&filename)?;
    let backup_dir = local_backup_dir()?;
    let source_path = backup_dir.join(filename.as_str());
    if !source_path.exists() {
        return Err(anyhow!("Backup file not found: {}", filename));
    }

    let dest_path = PathBuf::from(destination.as_str());
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    fs::copy(&source_path, &dest_path)
        .await
        .map(|_| ())
        .map_err(|err| anyhow!("Failed to export backup file: {err:#}"))?;
    Ok(())
}

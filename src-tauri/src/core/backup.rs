use crate::constants::files::DNS_CONFIG;
use crate::{config::Config, process::AsyncHandler, utils::dirs};
use anyhow::Error;
use arc_swap::{ArcSwap, ArcSwapOption};
use backon::{ConstantBuilder, Retryable as _};
use clash_verge_logging::{Type, logging};
use once_cell::sync::OnceCell;
use reqwest_dav::list_cmd::{ListEntity, ListFile, ListMultiStatus};
use smartstring::alias::String;
use std::{
    collections::HashMap,
    env::{consts::OS, temp_dir},
    io::Write as _,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{fs, time::timeout};
use zip::write::SimpleFileOptions;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

const TIMEOUT_UPLOAD: u64 = 300;
const TIMEOUT_DOWNLOAD: u64 = 300;
const TIMEOUT_LIST: u64 = 30;
const TIMEOUT_DELETE: u64 = 30;

#[derive(Clone)]
struct WebDavConfig {
    url: String,
    username: String,
    password: String,
}

#[derive(Debug, Clone, Copy, Hash, Eq, PartialEq)]
enum Operation {
    Upload,
    Download,
    List,
    Delete,
}

impl Operation {
    const fn timeout(&self) -> u64 {
        if cfg!(test) {
            return 1;
        }
        match self {
            Self::Upload => TIMEOUT_UPLOAD,
            Self::Download => TIMEOUT_DOWNLOAD,
            Self::List => TIMEOUT_LIST,
            Self::Delete => TIMEOUT_DELETE,
        }
    }
}

pub struct WebDavClient {
    config: ArcSwapOption<WebDavConfig>,
    clients: ArcSwap<HashMap<Operation, reqwest_dav::Client>>,
}

impl WebDavClient {
    pub fn global() -> &'static Self {
        static WEBDAV_CLIENT: OnceCell<WebDavClient> = OnceCell::new();
        WEBDAV_CLIENT.get_or_init(|| Self {
            config: ArcSwapOption::new(None),
            clients: ArcSwap::new(Arc::new(HashMap::new())),
        })
    }

    async fn get_client(&self, op: Operation) -> Result<reqwest_dav::Client, Error> {
        {
            let clients_map = self.clients.load();
            if let Some(client) = clients_map.get(&op) {
                return Ok(client.clone());
            }
        }

        let config = {
            let existing_config = self.config.load();

            if let Some(cfg_arc) = existing_config.clone() {
                (*cfg_arc).clone()
            } else {
                let verge = Config::verge().await.data_arc();
                if verge.webdav_url.is_none() || verge.webdav_username.is_none() || verge.webdav_password.is_none() {
                    let msg: String =
                        "Unable to create web dav client, please make sure the webdav config is correct".into();
                    return Err(anyhow::Error::msg(msg));
                }

                let config = WebDavConfig {
                    url: verge
                        .webdav_url
                        .clone()
                        .unwrap_or_default()
                        .trim_end_matches('/')
                        .into(),
                    username: verge.webdav_username.clone().unwrap_or_default(),
                    password: verge.webdav_password.clone().unwrap_or_default(),
                };

                self.config.store(Some(Arc::new(config.clone())));
                config
            }
        };

        let client = reqwest_dav::ClientBuilder::new()
            .set_agent(
                reqwest::Client::builder()
                    .use_rustls_tls()
                    .timeout(Duration::from_secs(op.timeout()))
                    .user_agent(format!("clash-verge/{APP_VERSION} ({OS} WebDAV-Client)"))
                    .redirect(reqwest::redirect::Policy::custom(|attempt| {
                        if attempt.previous().len() >= 5 {
                            attempt.error("重定向次数过多")
                        } else {
                            attempt.follow()
                        }
                    }))
                    .build()?,
            )
            .set_host(config.url.into())
            .set_auth(reqwest_dav::Auth::Basic(config.username.into(), config.password.into()))
            .build()?;

        // 直接使用 MKCOL；部分服务器的 depth-0 PROPFIND 会误报解码错误。
        if let Err(e) = client.mkcol(dirs::BACKUP_DIR).await {
            let (status_code, message) = match &e {
                reqwest_dav::Error::Decode(reqwest_dav::DecodeError::Server(server_err)) => {
                    (Some(server_err.response_code), Some(server_err.message.as_str()))
                }
                reqwest_dav::Error::Decode(reqwest_dav::DecodeError::StatusMismatched(status_err)) => {
                    (Some(status_err.response_code), None)
                }
                reqwest_dav::Error::Reqwest(http_err) => (http_err.status().map(|s| s.as_u16()), None),
                _ => (None, None),
            };

            // 409 表示父目录不存在，不能按消息启发式处理。
            if status_code == Some(409) {
                logging!(
                    warn,
                    Type::Backup,
                    "Backup directory cannot be created because its parent folder does not exist"
                );
                self.reset();
                return Err(anyhow::Error::msg(
                    "Failed to create backup directory: parent directory does not exist",
                ));
            }

            // 405 是标准的已存在响应；部分服务器只在消息里说明。
            let already_exists = status_code == Some(405)
                || message.is_some_and(|m| {
                    let m = m.to_ascii_lowercase();
                    m.contains("already exist") || m.contains("already taken")
                });

            if already_exists {
                logging!(info, Type::Backup, "Backup directory already exists");
            } else {
                logging!(warn, Type::Backup, "Failed to create backup directory");
                self.reset();
                return Err(e.into());
            }
        } else {
            logging!(info, Type::Backup, "Successfully created backup directory");
        }

        {
            self.clients.rcu(|clients_map| {
                let mut new_map = (**clients_map).clone();
                new_map.insert(op, client.clone());
                Arc::new(new_map)
            });
        }

        Ok(client)
    }

    pub fn reset(&self) {
        self.config.store(None);
        self.clients.store(Arc::new(HashMap::new()));
    }

    pub async fn upload(&self, path: PathBuf, name: String) -> Result<(), Error> {
        self.upload_inner(path, name).await.map_err(public_webdav_error)
    }
    pub async fn download(&self, name: String, path: PathBuf) -> Result<(), Error> {
        self.download_inner(name, path).await.map_err(public_webdav_error)
    }
    pub async fn list(&self) -> Result<Vec<ListFile>, Error> {
        self.list_inner().await.map_err(public_webdav_error)
    }
    pub async fn delete(&self, name: String) -> Result<(), Error> {
        self.delete_inner(name).await.map_err(public_webdav_error)
    }

    async fn upload_inner(&self, file_path: PathBuf, file_name: String) -> Result<(), Error> {
        super::backup_restore::validate_filename(&file_name)?;
        let client = self.get_client(Operation::Upload).await?;
        let webdav_path: String = format!("{}/{}", dirs::BACKUP_DIR, file_name).into();

        let file_content = fs::read(&file_path).await?;

        let backoff = ConstantBuilder::default()
            .with_delay(Duration::from_millis(500))
            .with_max_times(1);

        (|| async {
            timeout(
                Duration::from_secs(TIMEOUT_UPLOAD),
                client.put(&webdav_path, file_content.clone()),
            )
            .await??;
            Ok::<(), Error>(())
        })
        .retry(backoff)
        .notify(|_err, dur| {
            logging!(warn, Type::Backup, "Upload failed, retrying in {dur:?}");
        })
        .await
    }

    async fn download_inner(&self, filename: String, storage_path: PathBuf) -> Result<(), Error> {
        super::backup_restore::validate_filename(&filename)?;
        let client = self.get_client(Operation::Download).await?;
        let path = format!("{}/{}", dirs::BACKUP_DIR, filename);

        let fut = async {
            let response = client.get(path.as_str()).await?;
            let content = response.bytes().await?;
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&storage_path).await?;
            tokio::io::AsyncWriteExt::write_all(&mut file, &content).await?;
            file.sync_all().await?;
            Ok::<(), Error>(())
        };

        timeout(Duration::from_secs(TIMEOUT_DOWNLOAD), fut).await??;
        Ok(())
    }

    async fn list_inner(&self) -> Result<Vec<ListFile>, Error> {
        let client = self.get_client(Operation::List).await?;
        let path = format!("{}/", dirs::BACKUP_DIR);

        let fut = async {
            let response = client.list_raw(path.as_str(), reqwest_dav::Depth::Number(1)).await?;
            let status = response.status();
            if !status.is_success() {
                return Err(reqwest_dav::Error::Decode(reqwest_dav::DecodeError::StatusMismatched(
                    reqwest_dav::StatusMismatchedError {
                        response_code: status.as_u16(),
                        expected_code: 207,
                    },
                )));
            }

            let xml = response.text().await?;
            let files = parse_webdav_list(&xml)?;
            let mut final_files = Vec::new();
            for file in files {
                if let ListEntity::File(file) = file {
                    final_files.push(file);
                }
            }
            Ok::<Vec<ListFile>, reqwest_dav::Error>(final_files)
        };

        Ok(timeout(Duration::from_secs(TIMEOUT_LIST), fut).await??)
    }

    async fn delete_inner(&self, file_name: String) -> Result<(), Error> {
        super::backup_restore::validate_filename(&file_name)?;
        let client = self.get_client(Operation::Delete).await?;
        let path = format!("{}/{}", dirs::BACKUP_DIR, file_name);

        let fut = client.delete(&path);
        timeout(Duration::from_secs(TIMEOUT_DELETE), fut).await??;
        Ok(())
    }
}

fn public_webdav_error(error: Error) -> Error {
    let status = error
        .downcast_ref::<reqwest_dav::Error>()
        .and_then(|error| match error {
            reqwest_dav::Error::Decode(reqwest_dav::DecodeError::StatusMismatched(e)) => Some(e.response_code),
            reqwest_dav::Error::Decode(reqwest_dav::DecodeError::Server(e)) => Some(e.response_code),
            reqwest_dav::Error::Reqwest(e) => e.status().map(|s| s.as_u16()),
            _ => None,
        });
    let timed_out = error.is::<tokio::time::error::Elapsed>()
        || error
            .downcast_ref::<reqwest_dav::Error>()
            .is_some_and(|e| matches!(e, reqwest_dav::Error::Reqwest(e) if e.is_timeout()));
    if timed_out {
        return anyhow::anyhow!("WebDAV request timed out; retry later");
    }
    match status {
        Some(401 | 403) => anyhow::anyhow!("WebDAV authentication or permission denied; check credentials"),
        Some(status) => anyhow::anyhow!("WebDAV request failed (HTTP {status})"),
        None => anyhow::anyhow!("WebDAV operation failed; check connection, TLS certificate and server configuration"),
    }
}

fn parse_webdav_list(xml: &str) -> Result<Vec<ListEntity>, reqwest_dav::Error> {
    // Some WebDAV servers emit RFC 2822's numeric UTC offset instead of HTTP-date's `GMT`.
    let normalized_xml = xml.replace(" +0000</", " GMT</");
    let multi_status: ListMultiStatus = reqwest_dav::re_exports::serde_xml_rs::from_str(&normalized_xml)?;
    multi_status.responses.into_iter().map(ListEntity::try_from).collect()
}

pub async fn create_backup() -> Result<(String, PathBuf), Error> {
    let now = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let zip_file_name: String = format!("{OS}-backup-{now}-{}.zip", nanoid::nanoid!(8)).into();
    let zip_path = temp_dir().join(zip_file_name.as_str());

    create_backup_archive(&dirs::app_home_dir()?, &zip_path).await?;
    Ok((zip_file_name, zip_path))
}

async fn create_backup_archive(app_dir: &std::path::Path, zip_path: &std::path::Path) -> Result<(), Error> {
    for name in [
        "profiles",
        dirs::PROFILE_YAML,
        dirs::CLASH_CONFIG,
        dirs::VERGE_CONFIG,
        DNS_CONFIG,
    ] {
        let path = app_dir.join(name);
        if let Ok(metadata) = fs::symlink_metadata(path).await {
            anyhow::ensure!(
                !metadata.file_type().is_symlink(),
                "Linked configuration cannot be backed up"
            );
        }
    }
    let profiles_text = fs::read(app_dir.join(dirs::PROFILE_YAML)).await?;
    let profiles: crate::config::IProfiles = serde_yaml_ng::from_slice(&profiles_text)?;
    let mut archived_files = std::collections::HashSet::new();
    let value = zip_path.to_path_buf();
    let file = AsyncHandler::spawn_blocking(move || {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        options.open(&value)
    })
    .await??;
    let cleanup = scopeguard::guard(zip_path, |path| {
        if let Err(err) = std::fs::remove_file(path) {
            logging!(warn, Type::Backup, "Failed to remove incomplete backup: {err}");
        }
    });
    let mut zip = zip::ZipWriter::new(file);
    zip.add_directory("profiles/", SimpleFileOptions::default())?;
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    {
        let mut entries = fs::read_dir(app_dir.join("profiles")).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let file_type = entry.file_type().await?;
            anyhow::ensure!(!file_type.is_symlink(), "Linked profile files cannot be backed up");
            if file_type.is_file() {
                let file_name_os = entry.file_name();
                let file_name = file_name_os
                    .to_str()
                    .ok_or_else(|| anyhow::Error::msg("Invalid file name encoding"))?;
                let backup_path = format!("profiles/{}", file_name);
                zip.start_file(backup_path, options)?;
                let file_content = fs::read(&path).await?;
                zip.write_all(&file_content)?;
                archived_files.insert(file_name.to_owned());
            }
        }
    }
    for item in profiles.items.iter().flatten() {
        if let Some(file) = &item.file {
            anyhow::ensure!(
                archived_files.contains(file.as_str()),
                "An indexed profile file is missing from the backup"
            );
        }
    }
    zip.start_file(dirs::CLASH_CONFIG, options)?;
    zip.write_all(fs::read(app_dir.join(dirs::CLASH_CONFIG)).await?.as_slice())?;

    let verge_text = fs::read_to_string(app_dir.join(dirs::VERGE_CONFIG)).await?;
    let mut verge_config: serde_json::Value = serde_yaml_ng::from_str(&verge_text)?;
    if let Some(obj) = verge_config.as_object_mut() {
        obj.remove("webdav_username");
        obj.remove("webdav_password");
        obj.remove("webdav_url");
    }
    zip.start_file(dirs::VERGE_CONFIG, options)?;
    zip.write_all(serde_yaml_ng::to_string(&verge_config)?.as_bytes())?;

    let dns_config_path = app_dir.join(DNS_CONFIG);
    if dns_config_path.exists() {
        zip.start_file(DNS_CONFIG, options)?;
        zip.write_all(fs::read(&dns_config_path).await?.as_slice())?;
    }

    zip.start_file(dirs::PROFILE_YAML, options)?;
    zip.write_all(&profiles_text)?;
    zip.finish()?;
    scopeguard::ScopeGuard::into_inner(cleanup);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        async fn new() -> Self {
            let root = temp_dir().join(format!("verge-backup-test-{}", nanoid::nanoid!()));
            fs::create_dir_all(&root).await.unwrap();
            for name in [dirs::CLASH_CONFIG, dirs::VERGE_CONFIG, dirs::PROFILE_YAML] {
                fs::write(root.join(name), "{}\n").await.unwrap();
            }
            Self(root)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_archive(path: &std::path::Path, entries: &[(&str, &str)]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, content) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    fn mock_webdav(
        responses: Vec<(u16, std::string::String, u64)>,
    ) -> (WebDavClient, std::thread::JoinHandle<Vec<std::string::String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body, delay_ms) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut header = Vec::new();
                let mut byte = [0];
                while !header.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = std::string::String::from_utf8(header).unwrap();
                requests.push(header.lines().next().unwrap().to_owned());
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|s| s.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut bytes = vec![0; length];
                stream.read_exact(&mut bytes).unwrap();
                std::thread::sleep(Duration::from_millis(delay_ms));
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/xml\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
            requests
        });
        let client = WebDavClient {
            config: ArcSwapOption::new(Some(Arc::new(WebDavConfig {
                url: format!("http://{address}").into(),
                username: "synthetic-user".into(),
                password: "synthetic-secret".into(),
            }))),
            clients: ArcSwap::new(Arc::new(HashMap::new())),
        };
        (client, thread)
    }

    #[tokio::test]
    async fn mock_webdav_upload_list_download_delete_and_failures() {
        let fixture = Fixture::new().await;
        let upload = fixture.0.join("upload.zip");
        fs::write(&upload, "synthetic-archive").await.unwrap();
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/clash-verge/sample.zip</d:href><d:propstat><d:prop><d:resourcetype/><d:getlastmodified>Sun, 20 Sep 2026 00:00:00 GMT</d:getlastmodified><d:getcontentlength>17</d:getcontentlength><d:getcontenttype>application/zip</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let (client, server) = mock_webdav(vec![
            (405, "".into(), 0),
            (201, "".into(), 0),
            (405, "".into(), 0),
            (207, xml.into(), 0),
            (405, "".into(), 0),
            (200, "synthetic-archive".into(), 0),
            (405, "".into(), 0),
            (204, "".into(), 0),
        ]);
        client.upload(upload.clone(), "sample.zip".into()).await.unwrap();
        let list = client.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].href.ends_with("sample.zip"));
        let downloaded = fixture.0.join("download.zip");
        client.download("sample.zip".into(), downloaded.clone()).await.unwrap();
        assert_eq!(fs::read(&downloaded).await.unwrap(), fs::read(&upload).await.unwrap());
        client.delete("sample.zip".into()).await.unwrap();
        let requests = server.join().unwrap();
        for verb in ["PUT", "PROPFIND", "GET", "DELETE"] {
            assert!(requests.iter().any(|r| r.starts_with(verb)));
        }

        for status in [401, 403, 500] {
            let (client, server) = mock_webdav(vec![(status, "synthetic-secret".into(), 0)]);
            let error = client.list().await.unwrap_err().to_string();
            assert!(!error.contains("synthetic-secret"));
            assert!(error.contains(if status == 500 { "HTTP 500" } else { "authentication" }));
            server.join().unwrap();
        }
        let (client, server) = mock_webdav(vec![(405, "".into(), 0), (500, "".into(), 0), (500, "".into(), 0)]);
        assert!(client.upload(upload, "sample.zip".into()).await.is_err());
        server.join().unwrap();
        let (client, server) = mock_webdav(vec![(405, "".into(), 0), (207, "".into(), 1200)]);
        assert!(client.list().await.unwrap_err().to_string().contains("timed out"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn malformed_restore_does_not_overwrite_live_files() {
        let destination = Fixture::new().await;
        let archive = destination.0.join("incoming.zip");
        write_archive(
            &archive,
            &[
                (dirs::CLASH_CONFIG, "mixed-port: 19999\n"),
                (dirs::VERGE_CONFIG, "[broken"),
            ],
        );
        assert!(
            crate::core::backup_restore::restore(
                &destination.0,
                &archive,
                crate::core::backup_restore::RestoreMode::Full
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(destination.0.join(dirs::CLASH_CONFIG))
                .await
                .unwrap(),
            "{}\n"
        );
    }

    #[tokio::test]
    async fn aggregate_profiles_extensions_and_provider_settings_survive_archive_overwrite() {
        let source = Fixture::new().await;
        let destination = Fixture::new().await;
        fs::create_dir(source.0.join("profiles")).await.unwrap();
        fs::create_dir(destination.0.join("profiles")).await.unwrap();
        let index = "current: aggregate\nitems:\n  - uid: aggregate\n    type: local\n    file: aggregate.yaml\n    option:\n      merge: merge\n      script: script\n  - uid: merge\n    type: merge\n    file: merge.yaml\n  - uid: script\n    type: script\n    file: script.js\n";
        let files = [
            (
                "profiles/aggregate.yaml",
                "proxy-providers:\n  custom:\n    type: http\n    url: https://example.invalid/synthetic-subscription\n    path: ./providers/custom.yaml\n    interval: 3600\n    filter: synthetic\n    health-check:\n      enable: true\n      url: https://example.invalid/check\nproxy-groups:\n  - name: Application\n    type: select\n    use: [custom]\nrules: [MATCH,Application]\n",
            ),
            ("profiles/merge.yaml", "profile:\n  store-selected: true\n"),
            ("profiles/script.js", "function main(config) { return config; }\n"),
            (dirs::PROFILE_YAML, index),
            (DNS_CONFIG, "dns:\n  enable: true\n"),
        ];
        for (name, content) in files {
            fs::write(source.0.join(name), content).await.unwrap();
        }
        fs::write(
            source.0.join(dirs::VERGE_CONFIG),
            "language: en\nwebdav_url: synthetic-url\nwebdav_username: synthetic-user\nwebdav_password: synthetic-password\n",
        )
        .await
        .unwrap();
        fs::write(destination.0.join("profiles/aggregate.yaml"), "old-content")
            .await
            .unwrap();
        let archive_path = source.0.join("backup.zip");
        create_backup_archive(&source.0, &archive_path).await.unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(archive_path).unwrap()).unwrap();
        archive.extract(&destination.0).unwrap();
        for (name, content) in files {
            assert_eq!(fs::read_to_string(destination.0.join(name)).await.unwrap(), content);
        }
        let verge: serde_yaml_ng::Value = serde_yaml_ng::from_str(
            &fs::read_to_string(destination.0.join(dirs::VERGE_CONFIG))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(verge["language"].as_str(), Some("en"));
        for key in ["webdav_url", "webdav_username", "webdav_password"] {
            assert!(verge.get(key).is_none());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn linked_profiles_are_rejected_instead_of_reading_files_outside_the_backup() {
        let fixture = Fixture::new().await;
        fs::create_dir(fixture.0.join("profiles")).await.unwrap();
        fs::write(fixture.0.join("outside.yaml"), "synthetic-private-value")
            .await
            .unwrap();
        std::os::unix::fs::symlink(fixture.0.join("outside.yaml"), fixture.0.join("profiles/linked.yaml")).unwrap();
        let result = create_backup_archive(&fixture.0, &fixture.0.join("backup.zip")).await;
        assert!(result.is_err(), "Linked files must not be followed into a backup");
    }

    #[tokio::test]
    async fn failed_archive_creation_removes_partial_profile_data() {
        let fixture = Fixture::new().await;
        fs::create_dir(fixture.0.join("profiles")).await.unwrap();
        fs::write(fixture.0.join("profiles/aggregate.yaml"), "synthetic-provider-data")
            .await
            .unwrap();
        fs::remove_file(fixture.0.join(dirs::CLASH_CONFIG)).await.unwrap();
        let archive_path = fixture.0.join("backup.zip");
        assert!(create_backup_archive(&fixture.0, &archive_path).await.is_err());
        assert!(
            !archive_path.exists(),
            "Failed backups must not leave partial profile data on disk"
        );
    }

    #[tokio::test]
    async fn missing_indexed_profile_fails_instead_of_creating_incomplete_backup() {
        let fixture = Fixture::new().await;
        fs::create_dir(fixture.0.join("profiles")).await.unwrap();
        fs::write(
            fixture.0.join(dirs::PROFILE_YAML),
            "current: local\nitems:\n  - uid: local\n    type: local\n    file: aggregate.yaml\n",
        )
        .await
        .unwrap();
        let result = create_backup_archive(&fixture.0, &fixture.0.join("backup.zip")).await;
        assert!(result.is_err(), "Every indexed profile must exist in the backup");
    }

    #[tokio::test]
    async fn missing_profiles_directory_fails_instead_of_creating_incomplete_backup() {
        let fixture = Fixture::new().await;
        let result = create_backup_archive(&fixture.0, &fixture.0.join("backup.zip")).await;
        assert!(
            result.is_err(),
            "A backup without its profile files must not be accepted"
        );
    }
}

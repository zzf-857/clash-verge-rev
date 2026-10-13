use base64::{Engine as _, engine::general_purpose::STANDARD};
use parking_lot::Mutex;
use std::{collections::HashMap, sync::OnceLock};

#[cfg(any(target_os = "macos", test))]
mod icns;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// Icons larger than this are skipped; they are only drawn at avatar size.
const MAX_ICON_BYTES: usize = 512 * 1024;

pub(crate) struct IconData {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

fn load(exe: &str) -> Option<IconData> {
    #[cfg(target_os = "linux")]
    return linux::icon(exe);
    #[cfg(target_os = "macos")]
    return macos::icon(exe);
    #[cfg(windows)]
    return windows::icon(exe);
    #[allow(unreachable_code)]
    {
        let _ = exe;
        None
    }
}

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Returns a `data:` URL with the icon of the executable, or `None` when it has no icon.
pub fn executable_icon(exe: &str) -> Option<String> {
    if let Some(cached) = cache().lock().get(exe) {
        return cached.clone();
    }
    let url = load(exe)
        .filter(|icon| !icon.bytes.is_empty() && icon.bytes.len() <= MAX_ICON_BYTES)
        .map(|icon| format!("data:{};base64,{}", icon.mime, STANDARD.encode(icon.bytes)));
    cache().lock().insert(exe.to_owned(), url.clone());
    url
}

use super::IconData;
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant},
};

/// Newly installed apps show up after this long.
const INDEX_TTL: Duration = Duration::from_secs(300);
const ICON_SIZES: &[&str] = &["64x64", "48x48", "96x96", "128x128", "256x256", "scalable", "32x32"];

struct DesktopIndex {
    /// Executable path or basename -> `Icon=` value
    icons: HashMap<String, String>,
    built: Instant,
}

fn data_dirs() -> Vec<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let mut dirs = Vec::new();
    match env::var_os("XDG_DATA_HOME") {
        Some(dir) => dirs.push(PathBuf::from(dir)),
        None => dirs.extend(home.as_ref().map(|home| home.join(".local/share"))),
    }
    let system = env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    dirs.extend(system.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from));
    dirs.extend(home.map(|home| home.join(".local/share/flatpak/exports/share")));
    dirs.push("/var/lib/flatpak/exports/share".into());
    dirs.push("/var/lib/snapd/desktop".into());
    dirs
}

/// First real program of an `Exec=` line, skipping `env` and `VAR=value` prefixes.
fn exec_program(exec: &str) -> Option<String> {
    let mut rest = exec.trim_start();
    loop {
        let (token, next) = match rest.strip_prefix('"') {
            Some(quoted) => {
                let end = quoted.find('"')?;
                (&quoted[..end], &quoted[end + 1..])
            }
            None => {
                let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                rest.split_at(end)
            }
        };
        if token.is_empty() {
            return None;
        }
        if token != "env" && !token.contains('=') && !token.starts_with('-') {
            return Some(token.to_owned());
        }
        rest = next.trim_start();
    }
}

fn parse_desktop(content: &str) -> Option<(Option<String>, String)> {
    let mut in_entry = false;
    let (mut exec, mut try_exec, mut icon) = (None, None, None);
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some(value) = line.strip_prefix("Exec=") {
            exec = exec_program(value);
        } else if let Some(value) = line.strip_prefix("TryExec=") {
            try_exec = Some(value.trim().to_owned());
        } else if let Some(value) = line.strip_prefix("Icon=") {
            icon = Some(value.trim().to_owned());
        }
    }
    Some((exec.or(try_exec), icon.filter(|icon| !icon.is_empty())?))
}

fn build_index() -> DesktopIndex {
    let mut icons = HashMap::new();
    for dir in data_dirs() {
        let Ok(entries) = std::fs::read_dir(dir.join("applications")) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "desktop") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Some((program, icon)) = parse_desktop(&content) else {
                continue;
            };
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                icons.entry(stem.to_owned()).or_insert_with(|| icon.clone());
            }
            if let Some(program) = program {
                if let Some(name) = Path::new(&program).file_name().and_then(|name| name.to_str()) {
                    icons.entry(name.to_owned()).or_insert_with(|| icon.clone());
                }
                icons.entry(program).or_insert(icon);
            }
        }
    }
    DesktopIndex {
        icons,
        built: Instant::now(),
    }
}

fn icon_name_for(exe: &str) -> Option<String> {
    static INDEX: OnceLock<Mutex<Option<DesktopIndex>>> = OnceLock::new();
    let mut guard = INDEX.get_or_init(Default::default).lock();
    if guard.as_ref().is_none_or(|index| index.built.elapsed() > INDEX_TTL) {
        *guard = Some(build_index());
    }
    let index = guard.as_ref()?;
    let name = Path::new(exe).file_name()?.to_str()?;
    index
        .icons
        .get(exe)
        .or_else(|| index.icons.get(name))
        .cloned()
        // Many themes ship an icon named after the program even without a desktop entry.
        .or_else(|| Some(name.to_owned()))
}

fn read_icon(path: &Path) -> Option<IconData> {
    let mime = match path.extension()?.to_str()? {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    Some(IconData {
        mime,
        bytes: std::fs::read(path).ok()?,
    })
}

fn resolve_icon(name: &str) -> Option<IconData> {
    let direct = Path::new(name);
    if direct.is_absolute() {
        return read_icon(direct);
    }
    let mut roots: Vec<PathBuf> = data_dirs().into_iter().map(|dir| dir.join("icons")).collect();
    roots.extend(env::var_os("HOME").map(|home| PathBuf::from(home).join(".icons")));
    for size in ICON_SIZES {
        for root in &roots {
            for ext in ["png", "svg"] {
                let candidate = root
                    .join("hicolor")
                    .join(size)
                    .join("apps")
                    .join(format!("{name}.{ext}"));
                if candidate.is_file() {
                    return read_icon(&candidate);
                }
            }
        }
    }
    ["png", "svg"]
        .iter()
        .map(|ext| PathBuf::from(format!("/usr/share/pixmaps/{name}.{ext}")))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| read_icon(&candidate))
}

pub fn icon(exe: &str) -> Option<IconData> {
    resolve_icon(&icon_name_for(exe)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exec_and_icon() {
        let entry = "[Desktop Entry]\nName=Firefox\nExec=env MOZ_X11=1 /usr/lib/firefox/firefox %u\nIcon=firefox\n[Desktop Action new]\nExec=other\nIcon=ignored\n";
        assert_eq!(
            parse_desktop(entry),
            Some((Some("/usr/lib/firefox/firefox".into()), "firefox".into()))
        );
        assert_eq!(
            exec_program("\"/opt/My App/app\" --flag").as_deref(),
            Some("/opt/My App/app")
        );
        assert_eq!(parse_desktop("[Desktop Entry]\nExec=foo\n"), None);
    }
}

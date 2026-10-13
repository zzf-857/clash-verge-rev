use super::{IconData, icns::png_from_icns};
use std::path::{Path, PathBuf};

/// The outermost `.app` bundle, so helper apps nested inside share the main app icon.
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .filter(|path| path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("app")))
        .last()
        .map(Path::to_path_buf)
}

pub fn icon(exe: &str) -> Option<IconData> {
    let bundle = bundle_of(Path::new(exe))?;
    let contents = bundle.join("Contents");
    let info = plist::Value::from_file(contents.join("Info.plist")).ok()?;
    let name = info.as_dictionary()?.get("CFBundleIconFile")?.as_string()?;
    let mut icon_path = contents.join("Resources").join(name);
    if icon_path.extension().is_none() {
        icon_path.set_extension("icns");
    }
    let data = std::fs::read(icon_path).ok()?;
    let png = png_from_icns(&data)?;
    Some(IconData {
        mime: "image/png",
        bytes: png.to_vec(),
    })
}

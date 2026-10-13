// Modern icns entries embed plain PNG data, ordered here by how well they fit a small avatar.
const PREFERRED: &[&[u8; 4]] = &[b"ic12", b"ic07", b"ic13", b"ic08", b"ic11", b"ic14", b"ic09", b"ic10"];
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Extracts the best-sized PNG image from an `.icns` file.
pub fn png_from_icns(data: &[u8]) -> Option<&[u8]> {
    if data.get(..4)? != b"icns" {
        return None;
    }
    let mut entries = Vec::new();
    let mut offset = 8;
    while let Some(header) = data.get(offset..offset + 8) {
        let kind = &header[..4];
        let len = u32::from_be_bytes([header[4], header[5], header[6], header[7]]) as usize;
        if len < 8 {
            break;
        }
        let Some(body) = data.get(offset + 8..offset + len) else {
            break;
        };
        if body.starts_with(PNG_MAGIC) {
            entries.push((kind, body));
        }
        offset += len;
    }
    PREFERRED
        .iter()
        .find_map(|preferred| entries.iter().find(|(kind, _)| kind == preferred))
        .or_else(|| entries.first())
        .map(|(_, body)| *body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = kind.to_vec();
        out.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn picks_preferred_png_entry() {
        let small = [PNG_MAGIC, b"small"].concat();
        let large = [PNG_MAGIC, b"large"].concat();
        let body = [
            entry(b"is32", b"legacy-rgb"),
            entry(b"ic10", &large),
            entry(b"ic07", &small),
        ]
        .concat();
        let mut file = b"icns".to_vec();
        file.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
        file.extend_from_slice(&body);

        assert_eq!(png_from_icns(&file), Some(small.as_slice()));
        assert_eq!(png_from_icns(b"nope"), None);
    }
}

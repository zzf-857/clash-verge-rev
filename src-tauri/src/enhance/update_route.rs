use serde_yaml_ng::{Mapping, Value};
use std::{
    net::{Ipv4Addr, TcpListener},
    sync::OnceLock,
};

/// Hidden group profile updates go through when a direct download fails. Under TUN every other
/// route ends at the node the user is on, so a dead node would block the update that replaces it.
pub const UPDATE_GROUP: &str = "Clash Verge Update";
const UPDATE_LISTENER: &str = "clash-verge-update";

/// Loopback port of the listener that sends everything to [`UPDATE_GROUP`], whatever the rules
/// and mode say. Picked once per run so a config reload keeps the port the updater knows.
pub fn update_route_port() -> Option<u16> {
    static PORT: OnceLock<Option<u16>> = OnceLock::new();
    *PORT.get_or_init(|| {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|listener| listener.local_addr())
            .map(|addr| addr.port())
            .ok()
    })
}

fn push(config: &mut Mapping, key: &str, item: Mapping) {
    let mut items = match config.remove(key) {
        Some(Value::Sequence(seq)) => seq,
        _ => Vec::new(),
    };
    items.push(Value::Mapping(item));
    config.insert(key.into(), Value::Sequence(items));
}

fn mapping<const N: usize>(entries: [(&str, Value); N]) -> Mapping {
    entries.into_iter().map(|(key, value)| (key.into(), value)).collect()
}

pub fn use_update_route(mut config: Mapping) -> Mapping {
    let Some(port) = update_route_port() else {
        return config;
    };
    let has_nodes = config
        .get("proxies")
        .and_then(Value::as_sequence)
        .is_some_and(|proxies| !proxies.is_empty())
        || config
            .get("proxy-providers")
            .and_then(Value::as_mapping)
            .is_some_and(|providers| !providers.is_empty());
    if !has_nodes {
        return config;
    }

    // A select group has no health check of its own; the updater tests it right before use.
    push(
        &mut config,
        "proxy-groups",
        mapping([
            ("name", UPDATE_GROUP.into()),
            ("type", "select".into()),
            ("include-all", true.into()),
            ("hidden", true.into()),
        ]),
    );
    push(
        &mut config,
        "listeners",
        mapping([
            ("name", UPDATE_LISTENER.into()),
            ("type", "mixed".into()),
            ("listen", "127.0.0.1".into()),
            ("port", port.into()),
            ("udp", false.into()),
            ("proxy", UPDATE_GROUP.into()),
        ]),
    );
    config
}

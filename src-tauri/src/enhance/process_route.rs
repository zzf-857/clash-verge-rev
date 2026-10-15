use crate::config::{IProcessRouteGroup, ProcessMatchKind};
use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Sequence, Value};
use std::collections::HashSet;

const BUILTIN_EXITS: &[&str] = &["DIRECT", "REJECT"];

fn group_names(config: &Mapping) -> HashSet<std::string::String> {
    config
        .get("proxy-groups")
        .and_then(Value::as_sequence)
        .map(|seq| {
            seq.iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn generated_group(config: &Mapping, name: &str) -> Value {
    let mut proxies: Sequence = config
        .get("proxies")
        .and_then(Value::as_sequence)
        .map(|seq| {
            seq.iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .map(Value::from)
                .collect()
        })
        .unwrap_or_default();
    // Nodes first so a fresh group defaults to a real exit rather than DIRECT.
    proxies.extend(BUILTIN_EXITS.iter().map(|name| Value::from(*name)));

    let mut group = Mapping::new();
    group.insert("name".into(), name.into());
    group.insert("type".into(), "select".into());
    group.insert("proxies".into(), Value::Sequence(proxies));

    let providers: Sequence = config
        .get("proxy-providers")
        .and_then(Value::as_mapping)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    if !providers.is_empty() {
        group.insert("use".into(), Value::Sequence(providers));
    }

    Value::Mapping(group)
}

const fn rule_type(kind: ProcessMatchKind) -> &'static str {
    match kind {
        ProcessMatchKind::Name => "PROCESS-NAME",
        ProcessMatchKind::Path => "PROCESS-PATH",
        ProcessMatchKind::PathRegex => "PROCESS-PATH-REGEX",
    }
}

/// Prepends process rules for the enabled groups and generates a select group for each
/// group that does not route to an existing profile group.
pub fn use_process_routes(mut config: Mapping, groups: &[IProcessRouteGroup]) -> Mapping {
    let groups: Vec<_> = groups
        .iter()
        .filter(|group| group.enabled.unwrap_or(true) && !group.matchers.is_empty())
        .collect();
    if groups.is_empty() {
        return config;
    }

    let mut existing = group_names(&config);
    let mut new_groups = Sequence::new();
    let mut rules = Sequence::new();

    for group in groups {
        let policy = match group.target.as_deref().filter(|target| !target.is_empty()) {
            Some(target) if existing.contains(target) => target.to_owned(),
            // Pinned apps must never fall through to the profile's own rules, which may send
            // them out directly; with the exit gone their traffic is blocked instead.
            Some(target) => {
                logging!(
                    warn,
                    Type::Config,
                    "process route group '{}' targets missing proxy group '{}', its processes are blocked",
                    group.name,
                    target
                );
                "REJECT".to_owned()
            }
            None => {
                let name = group.name.trim().to_owned();
                if name.is_empty() || name.contains(',') {
                    continue;
                }
                // A profile group with the same name is reused as the exit.
                if existing.insert(name.clone()) {
                    new_groups.push(generated_group(&config, &name));
                }
                name
            }
        };

        for matcher in &group.matchers {
            // Rule payloads are comma separated, so a comma would corrupt the rule.
            if matcher.value.is_empty() || matcher.value.contains(',') {
                continue;
            }
            rules.push(Value::from(format!(
                "{},{},{}",
                rule_type(matcher.kind),
                matcher.value,
                policy
            )));
        }
    }

    if !new_groups.is_empty() {
        let mut all_groups = match config.remove("proxy-groups") {
            Some(Value::Sequence(seq)) => seq,
            _ => Sequence::new(),
        };
        all_groups.extend(new_groups);
        config.insert("proxy-groups".into(), Value::Sequence(all_groups));
    }

    if !rules.is_empty() {
        if let Some(Value::Sequence(existing_rules)) = config.remove("rules") {
            rules.extend(existing_rules);
        }
        config.insert("rules".into(), Value::Sequence(rules));

        let mode = config.get("find-process-mode").and_then(Value::as_str);
        if mode.is_none() || mode == Some("off") {
            config.insert("find-process-mode".into(), "strict".into());
        }
    }

    config
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests assert by panicking")]
mod tests {
    use super::*;
    use crate::config::IProcessMatcher;

    fn group(name: &str, target: Option<&str>, value: &str) -> IProcessRouteGroup {
        IProcessRouteGroup {
            id: name.into(),
            name: name.into(),
            target: target.map(Into::into),
            matchers: vec![IProcessMatcher {
                kind: ProcessMatchKind::Path,
                value: value.into(),
                label: None,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn prepends_rules_and_generates_select_group() {
        let config: Mapping = serde_yaml_ng::from_str(
            "proxies: [{name: A}, {name: B}]\nproxy-groups: [{name: Proxy, type: select, proxies: [A]}]\nfind-process-mode: off\nrules: ['MATCH,Proxy']",
        )
        .unwrap();
        let groups = [
            group("AI", None, "/usr/bin/claude"),
            group("Existing", Some("Proxy"), "/usr/bin/git"),
            group("Missing", Some("Nope"), "/usr/bin/curl"),
        ];

        let config = use_process_routes(config, &groups);

        let rules: Vec<_> = config["rules"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(
            rules,
            [
                "PROCESS-PATH,/usr/bin/claude,AI",
                "PROCESS-PATH,/usr/bin/git,Proxy",
                "PROCESS-PATH,/usr/bin/curl,REJECT",
                "MATCH,Proxy"
            ]
        );
        let ai = &config["proxy-groups"].as_sequence().unwrap()[1];
        assert_eq!(ai["name"].as_str(), Some("AI"));
        let members: Vec<_> = ai["proxies"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(members, ["A", "B", "DIRECT", "REJECT"]);
        assert_eq!(config["find-process-mode"].as_str(), Some("strict"));
    }
}

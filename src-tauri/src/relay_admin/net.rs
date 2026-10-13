//! The admin network policy: HTTPS public origins only, one DNS answer per
//! request that is vetted and then pinned, no proxies, no redirects.

use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::Pin,
    sync::Arc,
    time::Duration,
};
use url::{Host, Url};

pub(super) type Lookup<'a> =
    Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>>;

pub(super) trait Resolve: Send + Sync {
    fn lookup<'a>(&'a self, host: &'a str, port: u16) -> Lookup<'a>;
}

struct SystemDns;

impl Resolve for SystemDns {
    fn lookup<'a>(&'a self, host: &'a str, port: u16) -> Lookup<'a> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, port)).await?.collect()) })
    }
}

/// How admin requests reach the network. Production uses system DNS and the
/// public-address rule; tests substitute both to drive a loopback fixture.
#[derive(Clone)]
pub(super) struct Net {
    resolver: Arc<dyn Resolve>,
    allowed: fn(IpAddr) -> bool,
    #[cfg(test)]
    pub(super) root: Option<reqwest::Certificate>,
}

impl Net {
    pub(super) fn system() -> Self {
        Self {
            resolver: Arc::new(SystemDns),
            allowed: public,
            #[cfg(test)]
            root: None,
        }
    }

    #[cfg(test)]
    pub(super) fn custom(resolver: Arc<dyn Resolve>, allowed: fn(IpAddr) -> bool) -> Self {
        Self {
            resolver,
            allowed,
            root: None,
        }
    }

    /// Resolves once, refuses unless every answer is allowed, and returns a
    /// client that can connect only to those answers. The hostname stays in
    /// the URL, so TLS and NIP-98 still name it.
    pub(super) async fn client(&self, origin: &Url) -> Result<reqwest::Client, String> {
        let port = origin
            .port_or_known_default()
            .ok_or("Invalid admin origin")?;
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30));
        #[cfg(test)]
        if let Some(root) = &self.root {
            builder = builder.tls_certs_merge([root.clone()]);
        }
        match origin.host().ok_or("Invalid admin origin")? {
            Host::Ipv4(ip) if (self.allowed)(ip.into()) => {}
            Host::Ipv6(ip) if (self.allowed)(ip.into()) => {}
            Host::Ipv4(_) | Host::Ipv6(_) => return Err(REFUSED.into()),
            Host::Domain(name) => {
                // reqwest's timeouts start only after this lookup.
                let answers =
                    tokio::time::timeout(LOOKUP_TIMEOUT, self.resolver.lookup(name, port))
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .ok_or("The admin host could not be resolved")?;
                if answers.is_empty() {
                    return Err("The admin host could not be resolved".into());
                }
                if !answers.iter().all(|addr| (self.allowed)(addr.ip())) {
                    return Err(REFUSED.into());
                }
                let pinned: Vec<SocketAddr> = answers
                    .iter()
                    .map(|addr| SocketAddr::new(addr.ip(), port))
                    .collect();
                builder = builder.resolve_to_addrs(name, &pinned);
            }
        }
        builder
            .build()
            .map_err(|_| "Admin network client is unavailable".into())
    }
}

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
const REFUSED: &str = "The admin host resolves to a private or local address";

/// Syntactic admin-origin rule, checked before any lookup: an HTTPS origin
/// (no credentials, path, query or fragment), not a local name, and not a
/// non-public literal address.
pub(super) fn admin_origin(value: &str) -> Result<Url, String> {
    let url = crate::relay::origin(value)?;
    match url.host() {
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.');
            let local = ["localhost", "local", "internal", "home.arpa", "lan"]
                .iter()
                .any(|suffix| name == *suffix || name.ends_with(&format!(".{suffix}")));
            if local || !name.contains('.') {
                return Err("The admin host must be a public name".into());
            }
        }
        Some(Host::Ipv4(ip)) if public(ip.into()) => {}
        Some(Host::Ipv6(ip)) if public(ip.into()) => {}
        _ => return Err(REFUSED.into()),
    }
    Ok(url)
}

/// Globally routable unicast only: every range in the IANA IPv4 and IPv6
/// special-purpose address registries that is not marked globally reachable is
/// refused, with no exceptions of our own. Ranges the registry marks globally
/// reachable but that tunnel to arbitrary IPv4 (6to4, Teredo) or sit inside a
/// non-global block are refused too.
pub(super) fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => public_v4(v4),
            None => public_v6(v6),
        },
    }
}

/// `(network, prefix length)` blocks from the IANA IPv4 special-purpose
/// registry that are not globally reachable, plus multicast and 240/4.
const V4_REFUSED: &[([u8; 4], u8)] = &[
    ([0, 0, 0, 0], 8),       // "this network"
    ([10, 0, 0, 0], 8),      // private
    ([100, 64, 0, 0], 10),   // shared address space
    ([127, 0, 0, 0], 8),     // loopback
    ([169, 254, 0, 0], 16),  // link-local
    ([172, 16, 0, 0], 12),   // private
    ([192, 0, 0, 0], 24),    // IETF protocol assignments
    ([192, 0, 2, 0], 24),    // documentation
    ([192, 88, 99, 0], 24),  // deprecated 6to4 relay anycast
    ([192, 168, 0, 0], 16),  // private
    ([198, 18, 0, 0], 15),   // benchmarking
    ([198, 51, 100, 0], 24), // documentation
    ([203, 0, 113, 0], 24),  // documentation
    ([224, 0, 0, 0], 4),     // multicast
    ([240, 0, 0, 0], 4),     // reserved and broadcast
];

fn public_v4(ip: Ipv4Addr) -> bool {
    let ip = u32::from(ip);
    !V4_REFUSED.iter().any(|&(net, len)| {
        let mask = u32::MAX << (32 - len);
        ip & mask == u32::from_be_bytes(net)
    })
}

/// Blocks inside global unicast `2000::/3` that the IANA IPv6 special-purpose
/// registry lists as not globally reachable, or that embed arbitrary IPv4.
/// `2001::/23` (IETF protocol assignments) and `2002::/16` (6to4) are refused
/// whole as a deliberate conservative choice. This also blocks a few globally
/// reachable special-purpose ranges (PCP/TURN anycast, AMT, AS112, ORCHID);
/// no exceptions are carved out for them.
const V6_REFUSED: &[(u128, u8)] = &[
    (0x2001_0000 << 96, 23), // IETF protocol assignments (Teredo, benchmarking, ORCHID…)
    (0x2001_0db8 << 96, 32), // documentation
    (0x2002 << 112, 16),     // 6to4
    (0x3fff << 112, 20),     // documentation
];

fn public_v6(ip: Ipv6Addr) -> bool {
    let ip = u128::from(ip);
    // Everything outside 2000::/3 (loopback, ULA, link-local, multicast,
    // IPv4-compatible, NAT64 64:ff9b::/96 …) is not global unicast.
    ip >> 125 == 0b001
        && !V6_REFUSED.iter().any(|&(net, len)| {
            let mask = u128::MAX << (128 - len);
            ip & mask == net
        })
}

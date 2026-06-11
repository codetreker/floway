// `kind` matches the URI scheme for socks5 and trojan; http covers both
// http: and https: URIs via HttpProxyConfig.tls; ss / ss2022 share the
// `ss:` scheme and split on userinfo shape, and vless-tcp / vless-ws /
// reality share the `vless:` scheme and split on the `?type=` + `?security=`
// query params.

export type ProxyConfig =
  | HttpProxyConfig
  | Socks5ProxyConfig
  | ShadowsocksProxyConfig
  | Shadowsocks2022ProxyConfig
  | TrojanProxyConfig
  | VlessTcpTlsProxyConfig
  | VlessWsTlsProxyConfig
  | RealityProxyConfig;

interface ProxyConfigBase {
  /** Display label; equals the URI fragment if present, else "<host>:<port>". */
  name: string;
  host: string;
  port: number;
}

export interface HttpProxyConfig extends ProxyConfigBase {
  kind: 'http';
  /** When true, outer leg is TLS (HTTPS CONNECT). */
  tls: boolean;
  username?: string;
  password?: string;
}

export interface Socks5ProxyConfig extends ProxyConfigBase {
  kind: 'socks5';
  username?: string;
  password?: string;
}

export type SsMethod = 'aes-128-gcm' | 'aes-256-gcm' | 'chacha20-ietf-poly1305';

export interface ShadowsocksProxyConfig extends ProxyConfigBase {
  kind: 'ss';
  method: SsMethod;
  password: string;
}

export type Ss2022Method =
  | '2022-blake3-aes-128-gcm'
  | '2022-blake3-aes-256-gcm'
  | '2022-blake3-chacha20-poly1305';

export interface Shadowsocks2022ProxyConfig extends ProxyConfigBase {
  kind: 'ss2022';
  method: Ss2022Method;
  /** Base64-encoded PSK; decoded once at connect time. */
  passwordBase64: string;
}

export interface TrojanProxyConfig extends ProxyConfigBase {
  kind: 'trojan';
  password: string;
  sni?: string;
  allowInsecure?: boolean;
}

export interface VlessTcpTlsProxyConfig extends ProxyConfigBase {
  kind: 'vless-tcp';
  uuid: string;
}

export interface VlessWsTlsProxyConfig extends ProxyConfigBase {
  kind: 'vless-ws';
  uuid: string;
  /** WebSocket Host header; defaults to host. */
  wsHost?: string;
  path: string;
}

export interface RealityProxyConfig extends ProxyConfigBase {
  kind: 'reality';
  uuid: string;
  publicKey: string;        // pbk in URI form
  serverName: string;       // sni — required for REALITY
  shortId?: string;         // sid
}

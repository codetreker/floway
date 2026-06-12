import tls from 'node:tls';

// `tls.rootCertificates` is Node's bundled Mozilla CA list, shipped in
// lockstep with the Node release, plus anything Node folded in from
// `NODE_EXTRA_CA_CERTS` at process startup.
export const nodeRuntimeRootCAs: readonly string[] = tls.rootCertificates;

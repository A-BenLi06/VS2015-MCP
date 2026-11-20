import tls from 'node:tls';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';

function certificateError(code, message) { return Object.assign(new Error(message), { code }); }

// An explicit leaf pin is an alternative trust model for legacy devices whose
// certificates lack modern CA/SAN extensions. Never learn or update pins here.
// No HTTP bytes (including credentials) may be sent until this promise resolves.
export function connectPinnedPortal(url, sha256, signal) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const socket = tls.connect({ host, port: Number(url.port || 443), signal,
      servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => {
      try {
        const certificate = new X509Certificate(socket.getPeerCertificate().raw);
        if (certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== sha256)
          throw certificateError('PORTAL_CERTIFICATE_MISMATCH', 'The Portal leaf certificate does not match the configured SHA-256 pin.');
        const now = Date.now(), from = Date.parse(certificate.validFrom), to = Date.parse(certificate.validTo);
        if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to)
          throw certificateError('PORTAL_CERTIFICATE_EXPIRED', 'The pinned Portal certificate is outside its validity interval.');
        if (signal?.aborted) throw certificateError('ABORT_ERR', 'Cancelled during the Portal TLS handshake.');
        resolve(socket);
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.once('error', reject);
  });
}

package com.nowen.note;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.security.KeyStore;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertificateException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.X509Certificate;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509ExtendedTrustManager;
import javax.net.ssl.X509TrustManager;

/** TLS handshake only. Never sends HTTP, cookies, passwords, tokens or client certificates. API 24+. */
@android.annotation.TargetApi(24)
final class ServerTlsDiagnostics {
    static final class Result {
        String kind;
        X509Certificate certificate;
    }

    static Result inspect(String address) throws Exception {
        URL url = new URL(address);
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null
                || url.getQuery() != null || url.getRef() != null
                || !(url.getPath().isEmpty() || "/".equals(url.getPath()))) {
            throw new IllegalArgumentException("HTTPS origin required");
        }
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore) null);
        X509TrustManager system = null;
        for (TrustManager manager : factory.getTrustManagers()) {
            if (manager instanceof X509TrustManager) { system = (X509TrustManager) manager; break; }
        }
        if (system == null) throw new IllegalStateException("System trust manager unavailable");
        RecordingTrustManager recording = new RecordingTrustManager(system);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(new javax.net.ssl.KeyManager[0], new TrustManager[]{recording}, null);
        Result result = new Result();
        int port = url.getPort() == -1 ? 443 : url.getPort();
        try (Socket tcp = new Socket()) {
            tcp.connect(new InetSocketAddress(url.getHost(), port), 5000);
            try (SSLSocket tls = (SSLSocket) context.getSocketFactory().createSocket(tcp, url.getHost(), port, true)) {
                tls.setSoTimeout(5000);
                SSLParameters parameters = tls.getSSLParameters();
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                tls.setSSLParameters(parameters);
                tls.startHandshake();
            }
        } catch (Exception error) {
            result.kind = classify(error);
        }
        result.certificate = recording.leaf;
        return result;
    }

    static String classify(Throwable error) {
        boolean tlsError = false;
        boolean certificateError = false;
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof CertificateExpiredException) return "certificateExpired";
            if (cause instanceof CertificateNotYetValidException) return "certificateNotYetValid";
            String message = cause.getMessage() == null ? "" : cause.getMessage();
            if (message.matches("(?is).*(hostname .*not verified|no (subject alternative.*|name )matching.*|no subject alternative names present|no subjectAltNames on the certificate match).*")) return "hostnameMismatch";
            if (cause instanceof CertPathValidatorException) {
                CertPathValidatorException.Reason reason = ((CertPathValidatorException) cause).getReason();
                if (reason == CertPathValidatorException.BasicReason.EXPIRED) return "certificateExpired";
                if (reason == CertPathValidatorException.BasicReason.NOT_YET_VALID) return "certificateNotYetValid";
            }
            if (message.matches("(?is).*(trust anchor.*not found|unable to find valid certification path).*")) return "certificateUntrusted";
            tlsError |= cause instanceof SSLException;
            certificateError |= cause instanceof CertificateException;
        }
        return tlsError || certificateError ? "tlsFailed" : null;
    }

    /** Observe the leaf, but delegate every trust decision (including socket hostname checks). */
    static final class RecordingTrustManager extends X509ExtendedTrustManager {
        private final X509TrustManager system;
        X509Certificate leaf;

        RecordingTrustManager(X509TrustManager system) { this.system = system; }
        private void record(X509Certificate[] chain) { leaf = chain.length == 0 ? null : chain[0]; }
        public X509Certificate[] getAcceptedIssuers() { return system.getAcceptedIssuers(); }
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException { system.checkClientTrusted(chain, authType); }
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            record(chain);
            system.checkServerTrusted(chain, authType);
        }
        public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
            if (system instanceof X509ExtendedTrustManager) ((X509ExtendedTrustManager) system).checkClientTrusted(chain, authType, socket);
            else system.checkClientTrusted(chain, authType);
        }
        public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
            if (system instanceof X509ExtendedTrustManager) ((X509ExtendedTrustManager) system).checkClientTrusted(chain, authType, engine);
            else system.checkClientTrusted(chain, authType);
        }
        public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
            record(chain);
            if (system instanceof X509ExtendedTrustManager) ((X509ExtendedTrustManager) system).checkServerTrusted(chain, authType, socket);
            else throw new CertificateException("Extended system trust manager required");
        }
        public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
            record(chain);
            if (system instanceof X509ExtendedTrustManager) ((X509ExtendedTrustManager) system).checkServerTrusted(chain, authType, engine);
            else throw new CertificateException("Extended system trust manager required");
        }
    }
}

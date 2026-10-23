package com.nowen.note;

import static org.junit.Assert.*;
import java.io.IOException;
import java.net.Socket;
import java.security.cert.CertificateException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.X509Certificate;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.X509ExtendedTrustManager;
import org.junit.Test;

public class ServerTlsDiagnosticsTest {
    @Test
    public void unwrapsCertificateFailuresAndDoesNotGuessForNetworkFailures() {
        SSLHandshakeException expired = new SSLHandshakeException("Chain validation failed");
        expired.initCause(new CertificateException("Validation failed", new CertificateExpiredException()));
        assertEquals("certificateExpired", ServerTlsDiagnostics.classify(expired));
        assertEquals("certificateNotYetValid", ServerTlsDiagnostics.classify(new CertificateNotYetValidException()));
        assertEquals("hostnameMismatch", ServerTlsDiagnostics.classify(new CertificateException("No subject alternative DNS name matching notes.example.com found.")));
        assertEquals("hostnameMismatch", ServerTlsDiagnostics.classify(new SSLHandshakeException("No subjectAltNames on the certificate match")));
        assertEquals("certificateUntrusted", ServerTlsDiagnostics.classify(new CertificateException("Trust anchor for certification path not found.")));
        assertEquals("tlsFailed", ServerTlsDiagnostics.classify(new SSLHandshakeException("handshake failed")));
        assertNull(ServerTlsDiagnostics.classify(new IOException("Connection timed out")));
    }

    @Test
    public void rejectsAddressesContainingCredentialsPathsOrNonHttpsBeforeConnecting() throws Exception {
        for (String address : new String[]{"http://example.com", "https://user:password@example.com", "https://example.com/private", "https://example.com?token=secret", "https://example.com/#secret"}) {
            try {
                ServerTlsDiagnostics.inspect(address);
                fail("Must reject " + address);
            } catch (IllegalArgumentException expected) {
                assertEquals("HTTPS origin required", expected.getMessage());
            }
        }
    }

    @Test
    public void preservesEverySystemTrustRejectionIncludingSocketAndEngineChecks() throws Exception {
        RejectingTrustManager system = new RejectingTrustManager();
        ServerTlsDiagnostics.RecordingTrustManager recorder = new ServerTlsDiagnostics.RecordingTrustManager(system);
        X509Certificate[] chain = new X509Certificate[0];
        try { recorder.checkServerTrusted(chain, "RSA"); fail(); }
        catch (CertificateException rejected) { assertSame(system.rejection, rejected); }
        assertEquals("basic", system.called);
        try { recorder.checkServerTrusted(chain, "RSA", (Socket) null); fail(); }
        catch (CertificateException rejected) { assertSame(system.rejection, rejected); }
        assertEquals("socket", system.called);
        try { recorder.checkServerTrusted(chain, "RSA", (SSLEngine) null); fail(); }
        catch (CertificateException rejected) { assertSame(system.rejection, rejected); }
        assertEquals("engine", system.called);
        assertSame(system.issuers, recorder.getAcceptedIssuers());
    }

    private static final class RejectingTrustManager extends X509ExtendedTrustManager {
        final CertificateException rejection = new CertificateExpiredException("System rejected certificate");
        final X509Certificate[] issuers = new X509Certificate[0];
        String called;
        public X509Certificate[] getAcceptedIssuers() { return issuers; }
        public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException { called = "basic"; throw rejection; }
        public void checkServerTrusted(X509Certificate[] chain, String type, Socket socket) throws CertificateException { called = "socket"; throw rejection; }
        public void checkServerTrusted(X509Certificate[] chain, String type, SSLEngine engine) throws CertificateException { called = "engine"; throw rejection; }
        public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException { throw rejection; }
        public void checkClientTrusted(X509Certificate[] chain, String type, Socket socket) throws CertificateException { throw rejection; }
        public void checkClientTrusted(X509Certificate[] chain, String type, SSLEngine engine) throws CertificateException { throw rejection; }
    }
}

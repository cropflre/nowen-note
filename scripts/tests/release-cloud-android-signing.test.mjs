import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { escapeJavaProperty } from "../release-cloud-ci.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

test("Android signing secrets round-trip through Java Properties without truncation", (t) => {
  if (spawnSync("java", ["--version"]).status !== 0) {
    t.skip("Java is unavailable");
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-android-signing-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const password = " leading\\space:=#!\n中文🔑";
  const alias = "alias:with=special#chars";
  const properties = path.join(directory, "keystore.properties");
  fs.writeFileSync(
    properties,
    [
      `storePassword=${escapeJavaProperty(password)}`,
      `keyAlias=${escapeJavaProperty(alias)}`,
      "",
    ].join("\n"),
  );

  const java = path.join(directory, "ReadProperties.java");
  fs.writeFileSync(
    java,
    'import java.util.*;import java.io.*;class ReadProperties { public static void main(String[] args)throws Exception {var p=new Properties();try(var in=new FileInputStream(args[0])){p.load(in);}System.out.print(Base64.getEncoder().encodeToString((p.getProperty("storePassword")+"\\n"+p.getProperty("keyAlias")).getBytes(java.nio.charset.StandardCharsets.UTF_8)));}}',
  );

  const result = spawnSync("java", [java, properties], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.from(result.stdout, "base64").toString(), `${password}\n${alias}`);
});

test("release keystore identity is checked before Gradle without exposing signing secrets", (t) => {
  if (spawnSync("keytool", ["-help"]).status !== 0) { t.skip("keytool is unavailable"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-android-certificate-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  fs.mkdirSync(path.join(directory, "frontend/android/app"), { recursive:true });
  const keystore = path.join(directory, "fixture.p12"), password = "fixture-password", alias = "release-fixture";
  const generated = spawnSync("keytool", ["-genkeypair", "-alias", alias, "-keyalg", "EC", "-dname", "CN=release-fixture", "-validity", "1", "-storetype", "PKCS12", "-keystore", keystore, "-storepass", password, "-keypass", password], { encoding:"utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const certificate = spawnSync("keytool", ["-exportcert", "-keystore", keystore, "-alias", alias, "-storepass", password]);
  assert.equal(certificate.status, 0, certificate.stderr.toString());
  const fingerprint = createHash("sha256").update(certificate.stdout).digest("hex");
  const env = { ...process.env, GITHUB_ACTIONS:"true", GITHUB_REPOSITORY:"cropflre/nowen-note", NOWEN_ANDROID_KEYSTORE_B64:fs.readFileSync(keystore).toString("base64"), NOWEN_ANDROID_KEYSTORE_PASSWORD:password, NOWEN_ANDROID_KEY_ALIAS:alias, NOWEN_ANDROID_KEY_PASSWORD:password };
  const run = pin => spawnSync(process.execPath, [fileURLToPath(new URL("../release-cloud-ci.mjs", import.meta.url)), "android-signing"], { cwd:directory, encoding:"utf8", env:{...env,NOWEN_ANDROID_CERT_SHA256:pin} });
  const rejected = run("0".repeat(64));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, new RegExp(fingerprint));
  assert.ok(!rejected.stderr.includes(password));
  const accepted = run(fingerprint);
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("Android staging uses the installed pinned SDK even when a newer SDK is present", (t) => {
  if (process.platform === "win32") { t.skip("POSIX Android runner tools"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-android-stage-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const app = path.join(directory, "frontend/android/app");
  fs.mkdirSync(path.join(app, "build/outputs/apk/release"), { recursive:true });
  fs.mkdirSync(path.join(app, "build/outputs/bundle/release"), { recursive:true });
  fs.writeFileSync(path.join(app, "build.gradle"), 'versionCode 10510\nversionName "1.5.4"\n');
  fs.writeFileSync(path.join(app, "build/outputs/apk/release/app-release.apk"), "fixture-apk");
  fs.writeFileSync(path.join(app, "build/outputs/bundle/release/app-release.aab"), "fixture-aab");
  const fingerprint = "ab".repeat(32), sdk = path.join(directory, "sdk"), bin = path.join(directory, "bin");
  const command = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode:0o700 }); };
  command(path.join(sdk, "build-tools/37.0.0/apksigner"), "exit 99");
  command(path.join(sdk, "build-tools/36.0.0/apksigner"), 'if [ "$2" = "--print-certs" ]; then echo "Signer #1 certificate SHA-256 digest: $FIXTURE_CERT"; fi');
  command(path.join(sdk, "build-tools/36.0.0/aapt"), "echo \"package: name='com.nowen.note' versionCode='10510' versionName='1.5.4'\"");
  command(path.join(bin, "jarsigner"), "echo 'jar verified.'");
  const run = certificate => spawnSync(process.execPath, [fileURLToPath(new URL("../release-cloud-ci.mjs", import.meta.url)), "android-stage"], { cwd:directory, encoding:"utf8", env:{...process.env,PATH:`${bin}:${process.env.PATH}`,GITHUB_ACTIONS:"true",GITHUB_REPOSITORY:"cropflre/nowen-note",ANDROID_HOME:sdk,RC_VERSION:"1.5.4",NOWEN_ANDROID_CERT_SHA256:fingerprint,FIXTURE_CERT:certificate} });
  const accepted = run(fingerprint);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(fs.readFileSync(path.join(directory, "release-android/Nowen-Note-1.5.4.apk"), "utf8"), "fixture-apk");
  fs.rmSync(path.join(directory, "release-android"), { recursive:true });
  const rejected = run("cd".repeat(32));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not match NOWEN_ANDROID_CERT_SHA256/);
  assert.ok(!fs.existsSync(path.join(directory, "release-android")));
});

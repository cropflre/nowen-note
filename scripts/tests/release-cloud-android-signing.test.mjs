import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { escapeJavaProperty } from "../release-cloud-ci.mjs";

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

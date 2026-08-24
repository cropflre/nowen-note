import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RegistryConfig } from "../config.js";
import { withImmediateTransaction } from "../db/transaction.js";
import type { AuditLog } from "./audit.js";
import { canonicalJson, documentDigest, signDocument } from "./signing.js";

export interface RegistryRootRotation extends Record<string, unknown> {
  keyId: string;
  parentKeyId: string;
  sequence: number;
  algorithm: "Ed25519";
  publicKey: string;
  validFrom: string;
  validUntil: string;
  signature: string;
}

interface RootRow {
  keyId: string;
  parentKeyId: string | null;
  sequence: number;
  algorithm: "Ed25519";
  publicKey: string;
  validFrom: string;
  validUntil: string;
  signature: string | null;
  state: "active" | "superseded" | "pending" | "revoked";
  documentJson: string;
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ROTATION_KEYS = new Set(["keyId", "parentKeyId", "sequence", "algorithm", "publicKey", "validFrom", "validUntil", "signature"]);

function publicKeyBytes(value: string | crypto.KeyObject): Buffer {
  return crypto.createPublicKey(value).export({ type: "spki", format: "der" });
}

function samePublicKey(left: string | crypto.KeyObject, right: string | crypto.KeyObject): boolean {
  return publicKeyBytes(left).equals(publicKeyBytes(right));
}

function assertKeyDates(validFrom: string, validUntil: string, now: number): void {
  const from = Date.parse(validFrom);
  const until = Date.parse(validUntil);
  if (!Number.isFinite(from) || !Number.isFinite(until) || from > now + MAX_CLOCK_SKEW_MS || until <= from) {
    throw new Error("Registry root validity window is invalid");
  }
}

function assertActiveKeyWindow(validFrom: string, validUntil: string, now: number): void {
  assertKeyDates(validFrom, validUntil, now);
  if (Date.parse(validUntil) <= now) throw new Error("Registry root is expired");
}

function parseRotation(value: Record<string, unknown>): RegistryRootRotation {
  if (Object.keys(value).some((key) => !ROTATION_KEYS.has(key))
    || typeof value.keyId !== "string" || !value.keyId
    || typeof value.parentKeyId !== "string" || !value.parentKeyId
    || !Number.isSafeInteger(value.sequence)
    || value.algorithm !== "Ed25519"
    || typeof value.publicKey !== "string"
    || typeof value.validFrom !== "string" || typeof value.validUntil !== "string"
    || typeof value.signature !== "string" || !value.signature) {
    throw new Error("Registry root rotation envelope is invalid");
  }
  const publicKey = crypto.createPublicKey(value.publicKey);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Registry rotated root must be Ed25519");
  return value as unknown as RegistryRootRotation;
}

function verifyRotation(value: RegistryRootRotation, parent: RootRow, now: number): void {
  assertKeyDates(value.validFrom, value.validUntil, now);
  if (value.parentKeyId !== parent.keyId || value.sequence <= parent.sequence
    || Date.parse(value.validFrom) < Date.parse(parent.validFrom)
    || Date.parse(value.validFrom) > Date.parse(parent.validUntil)) throw new Error("Registry root rotation does not extend the active parent");
  const { signature, ...unsigned } = value;
  if (!crypto.verify(null, Buffer.from(canonicalJson(unsigned)), crypto.createPublicKey(parent.publicKey), Buffer.from(signature, "base64"))) {
    throw new Error("Registry root rotation parent signature is invalid");
  }
}

function parseStoredRotation(row: RootRow): RegistryRootRotation {
  let document: unknown;
  try { document = JSON.parse(row.documentJson); }
  catch { throw new Error("Stored Registry root rotation JSON is corrupt"); }
  const rotation = parseRotation(document as Record<string, unknown>);
  if (rotation.keyId !== row.keyId || rotation.parentKeyId !== row.parentKeyId || rotation.sequence !== row.sequence
    || rotation.publicKey !== row.publicKey || rotation.signature !== row.signature) throw new Error("Stored Registry root rotation differs from its columns");
  return rotation;
}

export class RegistryRootManager {
  constructor(
    private readonly db: DatabaseSync,
    private readonly config: RegistryConfig,
    private readonly audit: AuditLog,
  ) {}

  initialize(now = Date.now()): void {
    withImmediateTransaction(this.db, () => {
      let rows = this.db.prepare("SELECT * FROM registry_root_chain WHERE state<>'pending' ORDER BY sequence,keyId").all() as unknown as RootRow[];
      if (rows.length === 0) {
        assertActiveKeyWindow(this.config.signerValidFrom, this.config.signerValidUntil, now);
        const at = new Date(now).toISOString();
        const anchor = {
          keyId: this.config.signerKeyId,
          sequence: this.config.signerSequence,
          algorithm: "Ed25519",
          publicKey: this.config.signingPublicKeyPem,
          validFrom: this.config.signerValidFrom,
          validUntil: this.config.signerValidUntil,
        };
        this.db.prepare(`INSERT INTO registry_root_chain(keyId,parentKeyId,sequence,algorithm,publicKey,validFrom,validUntil,signature,state,documentJson,createdAt,updatedAt)
          VALUES (?,NULL,?,'Ed25519',?,?,?,?, 'active',?,?,?)`).run(
          anchor.keyId, anchor.sequence, anchor.publicKey, anchor.validFrom, anchor.validUntil, null, JSON.stringify(anchor), at, at,
        );
        this.audit.append({ actorType: "system", action: "registry_root.bootstrap", targetType: "registry_root", targetId: anchor.keyId, metadata: { sequence: anchor.sequence } });
        rows = this.db.prepare("SELECT * FROM registry_root_chain WHERE state<>'pending' ORDER BY sequence,keyId").all() as unknown as RootRow[];
      }

      const anchors = rows.filter((row) => row.parentKeyId === null);
      if (anchors.length !== 1) throw new Error("Registry root chain must contain exactly one anchor");
      let current = anchors[0]!;
      if (current.algorithm !== "Ed25519" || crypto.createPublicKey(current.publicKey).asymmetricKeyType !== "ed25519") throw new Error("Stored Registry anchor is invalid");
      assertKeyDates(current.validFrom, current.validUntil, now);
      const established = rows.filter((row) => row.parentKeyId !== null).sort((left, right) => left.sequence - right.sequence);
      for (const row of established) {
        const rotation = parseStoredRotation(row);
        verifyRotation(rotation, current, now);
        if (row.state !== "superseded" && row.state !== "active") throw new Error("Stored Registry root chain state is invalid");
        current = row;
      }
      if (current.state !== "active" || rows.some((row) => row !== current && row.state === "active")) throw new Error("Stored Registry root chain has an invalid active root");

      const configured = this.config.configuredRootRotations.map(parseRotation).sort((left, right) => left.sequence - right.sequence);
      for (const rotation of configured) {
        if (rotation.sequence <= current.sequence) {
          const known = rows.find((row) => row.sequence === rotation.sequence && row.keyId === rotation.keyId);
          if (!known || documentDigest(JSON.parse(known.documentJson) as Record<string, unknown>) !== documentDigest(rotation)) {
            throw new Error("Registry root rotation rollback or equivocation detected");
          }
          continue;
        }
        assertActiveKeyWindow(current.validFrom, current.validUntil, now);
        verifyRotation(rotation, current, now);
        const pending = this.db.prepare("SELECT * FROM registry_root_chain WHERE keyId=?").get(rotation.keyId) as unknown as RootRow | undefined;
        if (pending && (pending.state !== "pending" || documentDigest(JSON.parse(pending.documentJson) as Record<string, unknown>) !== documentDigest(rotation))) {
          throw new Error("Configured Registry rotation conflicts with persisted state");
        }
        const at = new Date(now).toISOString();
        this.db.prepare("UPDATE registry_root_chain SET state='superseded',updatedAt=? WHERE keyId=? AND state='active'").run(at, current.keyId);
        this.db.prepare(`INSERT INTO registry_root_chain(keyId,parentKeyId,sequence,algorithm,publicKey,validFrom,validUntil,signature,state,documentJson,createdAt,updatedAt)
          VALUES (?,?,?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(keyId) DO UPDATE SET state='active',updatedAt=excluded.updatedAt`).run(
          rotation.keyId, rotation.parentKeyId, rotation.sequence, rotation.algorithm, rotation.publicKey,
          rotation.validFrom, rotation.validUntil, rotation.signature, JSON.stringify(rotation), at, at,
        );
        this.audit.append({ actorType: "system", action: "registry_root.activate", targetType: "registry_root", targetId: rotation.keyId, metadata: { parentKeyId: rotation.parentKeyId, sequence: rotation.sequence } });
        current = this.db.prepare("SELECT * FROM registry_root_chain WHERE keyId=?").get(rotation.keyId) as unknown as RootRow;
        rows.push(current);
      }

      assertActiveKeyWindow(current.validFrom, current.validUntil, now);
      if (current.keyId !== this.config.signerKeyId || current.sequence !== this.config.signerSequence
        || current.validFrom !== this.config.signerValidFrom || current.validUntil !== this.config.signerValidUntil
        || !samePublicKey(current.publicKey, this.config.signingPublicKey)) {
        throw new Error("Configured Registry signer is not the persisted active root; a valid parent-signed rotation chain is required");
      }
    });
  }

  listPublishedRotations(): RegistryRootRotation[] {
    const rows = this.db.prepare(`SELECT * FROM registry_root_chain
      WHERE parentKeyId IS NOT NULL AND state IN ('active','superseded') ORDER BY sequence,keyId`).all() as unknown as RootRow[];
    return rows.map(parseStoredRotation);
  }

  generatePending(
    input: { keyId: string; publicKey: string; validFrom: string; validUntil: string },
    actorId: string,
    now = Date.now(),
  ): RegistryRootRotation {
    return withImmediateTransaction(this.db, () => {
      const parent = this.db.prepare("SELECT * FROM registry_root_chain WHERE state='active'").get() as unknown as RootRow | undefined;
      if (!parent || parent.keyId !== this.config.signerKeyId || !samePublicKey(parent.publicKey, this.config.signingPublicKey)) throw new Error("Configured signer is not the active Registry root");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.keyId) || input.keyId === parent.keyId) throw new Error("new Registry root keyId is invalid");
      if (this.db.prepare("SELECT 1 FROM registry_root_chain WHERE keyId=? OR state='pending'").get(input.keyId)) throw new Error("a Registry root rotation is already pending or keyId already exists");
      const publicKey = crypto.createPublicKey(input.publicKey);
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("new Registry root must be Ed25519");
      const normalizedPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
      const unsigned = {
        keyId: input.keyId,
        parentKeyId: parent.keyId,
        sequence: parent.sequence + 1,
        algorithm: "Ed25519" as const,
        publicKey: normalizedPublicKey,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
      };
      assertActiveKeyWindow(parent.validFrom, parent.validUntil, now);
      assertActiveKeyWindow(unsigned.validFrom, unsigned.validUntil, now);
      if (Date.parse(unsigned.validFrom) < Date.parse(parent.validFrom) || Date.parse(unsigned.validFrom) > Date.parse(parent.validUntil)) throw new Error("new Registry root validity must start within the parent window");
      const rotation = { ...unsigned, signature: signDocument(unsigned, this.config.signingPrivateKey) };
      const at = new Date(now).toISOString();
      this.db.prepare(`INSERT INTO registry_root_chain(keyId,parentKeyId,sequence,algorithm,publicKey,validFrom,validUntil,signature,state,documentJson,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)`).run(
        rotation.keyId, rotation.parentKeyId, rotation.sequence, rotation.algorithm, rotation.publicKey,
        rotation.validFrom, rotation.validUntil, rotation.signature, JSON.stringify(rotation), at, at,
      );
      this.audit.append({ actorType: "admin", actorId, action: "registry_root.generate", targetType: "registry_root", targetId: rotation.keyId, metadata: { parentKeyId: rotation.parentKeyId, sequence: rotation.sequence } });
      return rotation;
    });
  }
}

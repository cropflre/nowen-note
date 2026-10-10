// Independent Node/OpenSSL AES-GCM vector. The Argon2 KEK is the native-Argon2 v1 fixture's known output.
import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const base = JSON.parse(readFileSync(new URL('../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json', import.meta.url), 'utf8'));
const identity = { objectId: '00112233-4455-4677-8899-aabbccddeeff', kind: 'note', originalFormat: 'markdown', parentObjectId: null, documentSchemaVersion: 1, keyEpoch: 1, encryptionEpoch: 2 };
const aad = (purpose, context = []) => Buffer.from(JSON.stringify(['nowen-encrypted-content', 2, 'AES-256-GCM', purpose, identity.objectId, identity.kind, identity.originalFormat, identity.parentObjectId, identity.documentSchemaVersion, identity.keyEpoch, identity.encryptionEpoch, ...context]));
const seal = (key, iv, bytes, auth) => {
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(auth);
  return { iv: iv.toString('base64'), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64') };
};
const root = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 32));
const fileKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 64));
const fileContext = [1, '11223344-5566-4788-99aa-bbccddeeff00', '22334455-6677-4899-aabb-ccddeeff0011'];
const prefix = Buffer.from('8081828384858687', 'hex');
const filePlaintext = Buffer.from([0, 255, 128, 1, 42, 0, 10]);
const chunkIv = Buffer.concat([prefix, Buffer.alloc(4)]);
const chunk = seal(fileKey, chunkIv, filePlaintext, aad('file-chunk', [...fileContext, 0]));
const ciphertext = Buffer.from(chunk.ciphertext, 'base64');
const manifest = { version: 1, attachmentId: fileContext[1], uploadId: fileContext[2], noncePrefix: prefix.toString('base64'), name: '秘密图片.bin', mime: 'application/octet-stream', size: filePlaintext.length,
  wrappedKey: seal(root, Buffer.from('909192939495969798999a9b', 'hex'), fileKey, aad('file-key', fileContext)),
  chunks: [{ index: 0, ciphertextBytes: ciphertext.length, sha256: createHash('sha256').update(ciphertext).digest('hex') }] };
const document = { documentSchemaVersion: 1, content: '# 加密测试\n[文件](nowen-encrypted-attachment:' + manifest.attachmentId + ')\n', attachments: [manifest] };
const envelope = { ...identity, version: 2, algorithm: 'AES-256-GCM', kdf: base.envelope.kdf,
  wrappedKey: seal(Buffer.from(base.derivedKeyHex, 'hex'), Buffer.from('101112131415161718191a1b', 'hex'), root, aad('root-key')),
  payload: seal(root, Buffer.from('202122232425262728292a2b', 'hex'), Buffer.from(JSON.stringify(document)), aad('document')) };
const history = { version: 1, objectId: identity.objectId, keyEpoch: identity.keyEpoch, encryptionEpoch: identity.encryptionEpoch, historyId: '33445566-7788-49aa-bbcc-ddeeff001122', sourceVersion: 3, originalFormat: 'markdown' };
const historyDocument = { document: { documentSchemaVersion: 1, content: '旧版本 📝', attachments: [] }, changeSummary: '私密的版本说明' };
history.payload = seal(root, Buffer.from('303132333435363738393a3b', 'hex'), Buffer.from(JSON.stringify(historyDocument)), aad('history', [history.version, history.historyId, history.sourceVersion, history.originalFormat]));
writeFileSync(new URL('../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v2.json', import.meta.url), JSON.stringify({ generatedBy: 'Independent Node/OpenSSL AES-GCM; native Argon2id KEK from v1 vector', passphrase: base.passphrase, envelope, document, history, historyDocument, filePlaintext: filePlaintext.toString('base64'), fileCiphertext: chunk.ciphertext }, null, 2) + '\n');
root.fill(0); fileKey.fill(0);

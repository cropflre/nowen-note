import { DatabaseSync } from "node:sqlite";

export function openRegistry(path: string): DatabaseSync {
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS developers(id TEXT PRIMARY KEY,githubId TEXT UNIQUE NOT NULL,login TEXT NOT NULL,avatar TEXT,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS publishers(id TEXT PRIMARY KEY,displayName TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',website TEXT,github TEXT,verified INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS publisher_members(publisherId TEXT NOT NULL,developerId TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(publisherId,developerId));
    CREATE TABLE IF NOT EXISTS publisher_keys(id TEXT PRIMARY KEY,publisherId TEXT NOT NULL,publicKey TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',validFrom TEXT NOT NULL,validUntil TEXT,revokedAt TEXT);
    CREATE TABLE IF NOT EXISTS extensions(id TEXT PRIMARY KEY,publisherId TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,repository TEXT NOT NULL,license TEXT NOT NULL,trustLevel TEXT NOT NULL DEFAULT 'community',listed INTEGER NOT NULL DEFAULT 1,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS extension_versions(extensionId TEXT NOT NULL,version TEXT NOT NULL,apiVersion INTEGER NOT NULL,runtime TEXT NOT NULL,manifestJson TEXT NOT NULL,artifactPath TEXT NOT NULL,artifactUrl TEXT NOT NULL,sha256 TEXT NOT NULL,publisherKeyId TEXT NOT NULL,signature TEXT NOT NULL,scanState TEXT NOT NULL,scanReportJson TEXT NOT NULL,publishedAt TEXT NOT NULL,PRIMARY KEY(extensionId,version));
    CREATE TABLE IF NOT EXISTS extension_reviews(id TEXT PRIMARY KEY,extensionId TEXT NOT NULL,version TEXT NOT NULL,developerId TEXT NOT NULL,rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),comment TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(extensionId,version,developerId));
    CREATE TABLE IF NOT EXISTS extension_reports(id TEXT PRIMARY KEY,extensionId TEXT NOT NULL,version TEXT,developerId TEXT NOT NULL,reason TEXT NOT NULL,details TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS security_advisories(id TEXT PRIMARY KEY,extensionId TEXT NOT NULL,versionsJson TEXT NOT NULL,state TEXT NOT NULL,severity TEXT NOT NULL,title TEXT NOT NULL,detailsUrl TEXT,action TEXT NOT NULL DEFAULT 'warn',createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_extension_stats(day TEXT NOT NULL,extensionId TEXT NOT NULL,event TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,extensionId,event));
  `); return db;
}

import { installSystemDnsLookupCompat } from "../lib/dnsSystemLookupCompat.js";

// Must run before index.ts imports the URL-import router, which captures
// dns.resolve4/resolve6 with promisify during module evaluation.
installSystemDnsLookupCompat();

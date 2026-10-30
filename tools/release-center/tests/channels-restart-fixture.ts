import { Store } from "../server/store.ts";
import { Channels } from "../server/channels.ts";
import { GitHub } from "../server/github.ts";

const store = new Store(process.argv[2]);
const github = new GitHub("", async () => { throw new Error("Recovery must not query the network"); });
const channels = new Channels(store, github);
const raw = JSON.parse(process.argv[3]);
channels.record(raw);
console.log(JSON.stringify(channels.view(raw.version)));
store.close();

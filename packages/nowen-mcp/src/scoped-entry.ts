#!/usr/bin/env node
import "./scoped-fetch.js";
const { main } = await import("./index.js");
await main();

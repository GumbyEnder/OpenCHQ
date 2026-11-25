// Census driver: run ONE node file without the full suite (used by pb245 mutant census).
const file = process.argv[2];
const mod = await import("./" + file);
await mod.run({});
console.log("ONE_OK " + file);

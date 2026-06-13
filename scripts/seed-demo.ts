// Seed a store with demo data for screenshots / local UI development.
//   npx tsx scripts/seed-demo.ts <dbPath>
import { Store } from "../src/store/store";

const dbPath = process.argv[2] ?? "./state/whatspac.db";
const now = 1_718_300_000_000; // fixed (no Date.now in deterministic contexts)
const store = new Store(dbPath);

store.upsertChannelHeader({ cid: "general", cn: "General" });
store.setChannelSubscribed("general", true);
store.upsertChannelHeader({ cid: "tech", cn: "Tech Talk" });
store.setChannelSubscribed("tech", true);
store.upsertChannelHeader({ cid: "dx", cn: "DX Cluster" });

store.upsertHam({ c: "M0ABC", n: "Alice", ts: now });
store.upsertHam({ c: "G4XYZ", n: "Bob", ts: now });
store.setOnline(["M0ABC", "G4XYZ", "M0LTE"]);

store.putPost({ t: "cp", cid: "general", fc: "M0ABC", p: "Morning all — anyone on 2m simplex?", ts: now - 3_600_000, _id: "p1" });
store.putPost({ t: "cp", cid: "general", fc: "G4XYZ", p: "Here! Strong signal from the hilltop today.", ts: now - 1_800_000, _id: "p2" });
store.putPost({ t: "cp", cid: "general", fc: "M0ABC", p: "Nice. Switching to the beam.", ts: now - 1_200_000, _id: "p3" });
store.putPost({ t: "cp", cid: "tech", fc: "G4XYZ", p: "whatspacd keeps the WPS link up while the tab is closed — finally.", ts: now - 600_000, _id: "p4" });

store.putDirectMessage({ t: "m", fc: "M0ABC", tc: "M0LTE", m: "Hey Tom, got your packet — 73!", ts: Math.floor((now - 300_000) / 1000), _id: "d1" });
store.putDirectMessage({ t: "m", fc: "M0LTE", tc: "M0ABC", m: "Cheers Alice, copy that.", ts: Math.floor((now - 240_000) / 1000), _id: "d2" });

store.close();
console.log(`seeded ${dbPath}`);

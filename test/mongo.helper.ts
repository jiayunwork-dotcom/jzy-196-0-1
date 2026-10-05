import { Db, MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ensureIndexes } from '../src/persistence/mongo';

// The sandbox runs Debian 12; mongodb-memory-server's platform detection
// does not map it, so pin the Ubuntu 22.04 build (glibc compatible).
process.env.MONGOMS_DISTRO = process.env.MONGOMS_DISTRO ?? 'ubuntu-22.04';
process.env.MONGOMS_VERSION = process.env.MONGOMS_VERSION ?? '7.0.14';

export interface TestMongo {
  mongod: MongoMemoryServer;
  client: MongoClient;
  db: Db;
  uri: string;
}

let shared: TestMongo | null = null;
let dbCounter = 0;

/** One shared in-memory MongoDB per test file; each suite gets a fresh database. */
export async function freshDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  if (!shared) {
    const mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    const client = new MongoClient(uri);
    await client.connect();
    shared = { mongod, client, db: client.db('__unused'), uri };
  }
  const db = shared.client.db(`test_${Date.now()}_${dbCounter++}`);
  await ensureIndexes(db);
  return {
    db,
    cleanup: async () => {
      await db.dropDatabase();
    },
  };
}

export async function stopSharedMongo(): Promise<void> {
  if (shared) {
    await shared.client.close();
    await shared.mongod.stop();
    shared = null;
  }
}

export function sharedMongoUri(): string | null {
  return shared?.uri ?? null;
}

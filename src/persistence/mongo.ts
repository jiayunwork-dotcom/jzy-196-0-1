import { Db, MongoClient } from 'mongodb';

/** Shared Mongo connection provider. */
export class MongoConnection {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  constructor(
    private readonly uri: string = process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
    private readonly dbName: string = process.env.MONGODB_DB ?? 'dispatch',
  ) {}

  async connect(): Promise<Db> {
    if (this.db) return this.db;
    this.client = new MongoClient(this.uri);
    // Mongo may still be starting when the API boots (docker-compose).
    const attempts = 30;
    let lastError: unknown;
    for (let k = 0; k < attempts; k++) {
      try {
        await this.client.connect();
        this.db = this.client.db(this.dbName);
        await ensureIndexes(this.db);
        return this.db;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw lastError;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.db = null;
  }
}

export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection('days').createIndex({ date: 1 }, { unique: true });
  await db.collection('versions').createIndex({ date: 1, version: 1 }, { unique: true });
}

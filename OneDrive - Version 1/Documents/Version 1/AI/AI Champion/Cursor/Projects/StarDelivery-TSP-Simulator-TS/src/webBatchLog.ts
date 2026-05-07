import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BatchRunReport } from "./types.js";

export interface StoredBatchRun {
  id: number;
  startedAtUtc: string;
  submit: boolean;
  playerGuid: string;
  playerEmail: string;
  report: BatchRunReport;
  logLines: string[];
}

interface StoreFile {
  nextId: number;
  items: StoredBatchRun[];
}

const maxItems = 50;

export class WebBatchLog {
  constructor(private readonly filePath: string) {}

  async readAll(): Promise<StoredBatchRun[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as StoreFile;
      return data.items ?? [];
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return [];
      throw e;
    }
  }

  async append(record: Omit<StoredBatchRun, "id" | "startedAtUtc">): Promise<StoredBatchRun> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let data: StoreFile = { nextId: 1, items: [] };
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      data = JSON.parse(raw) as StoreFile;
    } catch {
      /* new file */
    }

    const id = data.nextId++;
    const startedAtUtc = new Date().toISOString();
    const full: StoredBatchRun = { id, startedAtUtc, ...record };
    data.items.unshift(full);
    data.items = data.items.slice(0, maxItems);
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
    return full;
  }

  async getById(id: number): Promise<StoredBatchRun | undefined> {
    const items = await this.readAll();
    return items.find((x) => x.id === id);
  }
}

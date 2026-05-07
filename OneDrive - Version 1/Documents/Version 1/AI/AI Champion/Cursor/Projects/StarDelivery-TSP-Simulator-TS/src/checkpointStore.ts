import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface CheckpointRow {
  playerGuid: string;
  playerEmail: string;
  challengeId: number;
  resumeFromK: number;
  updatedAtUtc: string;
}

function keyOf(guid: string, email: string, challengeId: number): string {
  return `${guid}|${email}|${challengeId}`;
}

/** JSON file persistence analogous to `ChallengeKCheckpoints`. */
export class FileCheckpointStore {
  constructor(private readonly filePath: string) {}

  async loadAll(): Promise<Map<string, CheckpointRow>> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const arr = JSON.parse(raw) as CheckpointRow[];
      const m = new Map<string, CheckpointRow>();
      for (const row of arr) {
        m.set(keyOf(row.playerGuid, row.playerEmail, row.challengeId), row);
      }
      return m;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return new Map();
      throw e;
    }
  }

  private async saveAll(map: Map<string, CheckpointRow>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const arr = [...map.values()].sort(
      (a, b) => new Date(b.updatedAtUtc).getTime() - new Date(a.updatedAtUtc).getTime(),
    );
    await fs.writeFile(this.filePath, JSON.stringify(arr, null, 2), "utf8");
  }

  async getResumeK(
    playerGuid: string,
    playerEmail: string,
    challengeId: number,
  ): Promise<number | undefined> {
    const map = await this.loadAll();
    return map.get(keyOf(playerGuid, playerEmail, challengeId))?.resumeFromK;
  }

  async save(playerGuid: string, playerEmail: string, challengeId: number, resumeFromK: number): Promise<void> {
    const map = await this.loadAll();
    const row: CheckpointRow = {
      playerGuid,
      playerEmail,
      challengeId,
      resumeFromK,
      updatedAtUtc: new Date().toISOString(),
    };
    map.set(keyOf(playerGuid, playerEmail, challengeId), row);
    await this.saveAll(map);
  }

  async clear(playerGuid: string, playerEmail: string, challengeId: number): Promise<void> {
    const map = await this.loadAll();
    map.delete(keyOf(playerGuid, playerEmail, challengeId));
    await this.saveAll(map);
  }
}

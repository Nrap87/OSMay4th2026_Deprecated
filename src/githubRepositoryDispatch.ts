/**
 * Trigger GitHub repository_dispatch workflows (token via env only — never sent to the browser).
 */

export type GithubDispatchConfigPublic = {
  configured: boolean;
  owner: string;
  repo: string;
  eventType: string;
};

export function getGithubDispatchConfigPublic(): GithubDispatchConfigPublic {
  const token = process.env.GITHUB_DISPATCH_TOKEN?.trim();
  return {
    configured: Boolean(token),
    owner: process.env.GITHUB_DISPATCH_OWNER ?? "Nrap87",
    repo: process.env.GITHUB_DISPATCH_REPO ?? "OSMay4th2026",
    eventType: process.env.GITHUB_DISPATCH_EVENT_TYPE ?? "scheduled-run",
  };
}

export async function postRepositoryDispatch(): Promise<{ status: number; message: string }> {
  const token = process.env.GITHUB_DISPATCH_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "GITHUB_DISPATCH_TOKEN is not set. Add it to the server environment (do not put tokens in the UI or repo).",
    );
  }
  const { owner, repo, eventType } = getGithubDispatchConfigPublic();
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "StarDelivery-TSP-Simulator-TS",
    },
    body: JSON.stringify({ event_type: eventType }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 800)}`);
  }
  return {
    status: res.status,
    message: text.trim() || `HTTP ${res.status} (empty body — typical for 204 No Content)`,
  };
}

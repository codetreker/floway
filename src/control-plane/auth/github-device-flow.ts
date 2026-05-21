import { githubHeaders } from "../../shared/copilot.ts";
import type { GitHubAccount } from "../../repo/types.ts";

type GitHubUser = GitHubAccount["user"];

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_SCOPES = "read:user";

interface GitHubDeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export const startGitHubDeviceFlow = async () => {
  const resp = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_SCOPES,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false as const, error: `GitHub error: ${text}` };
  }

  const data = (await resp.json()) as GitHubDeviceFlowStart;
  return { ok: true as const, data };
};

export const pollGitHubDeviceFlow = async (deviceCode: string) => {
  const resp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  return (await resp.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };
};

export const fetchGitHubUser = async (githubToken: string) => {
  const userResp = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `token ${githubToken}`,
      accept: "application/json",
      "user-agent": "copilot-gateway",
    },
  });

  if (userResp.ok) {
    return (await userResp.json()) as GitHubUser;
  }

  return {
    login: "unknown",
    avatar_url: "",
    name: null,
    id: 0,
  } satisfies GitHubUser;
};

export const detectAccountType = async (
  githubToken: string,
): Promise<string> => {
  try {
    const resp = await fetch("https://api.github.com/copilot_internal/user", {
      headers: await githubHeaders(githubToken),
    });
    if (!resp.ok) return "individual";
    const data = (await resp.json()) as { copilot_plan?: string };
    if (
      data.copilot_plan &&
      ["individual", "business", "enterprise"].includes(data.copilot_plan)
    ) {
      return data.copilot_plan;
    }
    return "individual";
  } catch {
    return "individual";
  }
};

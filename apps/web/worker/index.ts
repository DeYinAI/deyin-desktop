/**
 * Chat-only Worker for chat.openference.com: static SPA + Openference API proxy.
 * No WebSocket host-server, no Containers/Sandbox.
 */

import { isLegacyPwaAssetPath, legacySwKillResponse } from "./legacy-pwa";

export interface Env {
  ASSETS: Fetcher;
  OPENFERENCE_API_URL: string;
  OPENFERENCE_SITE_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, mode: "chat-only" });
    }

    if (url.pathname === "/api/me") {
      return handleMe(request, env);
    }

    if (url.pathname === "/api/user/me") {
      return handleUserMe(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return proxyToOpenference(request, env);
    }

    if (isLegacyPwaAssetPath(url.pathname)) {
      return legacySwKillResponse();
    }

    return env.ASSETS.fetch(request);
  },
};

/** Validate dashboard session tokens against openference.com (legacy SSO + /api/me). */
async function handleMe(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return Response.json({ error: "missing_authorization" }, { status: 401 });
  }
  const token = auth.slice(7);
  const site = env.OPENFERENCE_SITE_URL.replace(/\/+$/, "");

  const profileRes = await fetch(`${site}/api/user/me`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (profileRes.ok) {
    const data = (await profileRes.json()) as {
      userId: number;
      email: string;
      avatarUrl?: string;
      firstName?: string;
      lastName?: string;
      handle?: string;
      planId?: string;
      subscriptionStatus?: string;
      plan?: { name?: string };
    };
    return Response.json({
      id: data.userId,
      email: data.email,
      avatarUrl: data.avatarUrl,
      firstName: data.firstName,
      lastName: data.lastName,
      handle: data.handle,
      plan: data.plan?.name || data.planId || "free",
      subscriptionStatus: data.subscriptionStatus,
    });
  }

  const basicRes = await fetch(`${site}/auth/me`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!basicRes.ok) {
    return Response.json({ error: "Invalid session" }, { status: 401 });
  }
  const basic = (await basicRes.json()) as {
    user?: {
      id: number;
      email: string;
      avatarUrl?: string;
      firstName?: string;
      lastName?: string;
    };
  };
  if (!basic.user) {
    return Response.json({ error: "Invalid session" }, { status: 401 });
  }
  return Response.json({
    id: basic.user.id,
    email: basic.user.email,
    avatarUrl: basic.user.avatarUrl,
    firstName: basic.user.firstName,
    lastName: basic.user.lastName,
  });
}

/** Full Openference profile + usage quotas for Account settings (same-origin, no CORS). */
async function handleUserMe(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return Response.json({ error: "missing_authorization" }, { status: 401 });
  }
  const site = env.OPENFERENCE_SITE_URL.replace(/\/+$/, "");
  const profileRes = await fetch(`${site}/api/user/me`, {
    headers: { authorization: auth, "content-type": "application/json" },
  });
  if (!profileRes.ok) {
    return new Response(profileRes.body, {
      status: profileRes.status,
      headers: { "content-type": profileRes.headers.get("content-type") ?? "application/json" },
    });
  }
  const data = await profileRes.json();
  return Response.json(data);
}

async function proxyToOpenference(request: Request, env: Env): Promise<Response> {
  const upstreamPath = new URL(request.url).pathname.replace(/^\/api/, "");
  const auth = request.headers.get("authorization");
  if (!auth) {
    return Response.json({ error: "missing_authorization" }, { status: 401 });
  }

  const base = env.OPENFERENCE_API_URL.replace(/\/+$/, "");
  const upstream = await fetch(`${base}${upstreamPath}${new URL(request.url).search}`, {
    method: request.method,
    headers: {
      authorization: auth,
      "content-type": request.headers.get("content-type") ?? "application/json",
    },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}

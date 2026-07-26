/**
 * Example: a third-party CLI adding "Sign in with Openference".
 *
 * Demonstrates that @deyin/oauth-client is reusable outside Deyin. Run against the dev
 * provider (`pnpm oauth:dev`):
 *
 *   tsx examples/cli-login.ts --issuer http://localhost:8788 [--device]
 *
 * By default it uses the loopback (browser) flow; pass --device for the headless flow.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { OAuthClient } from "../src/index.js";
import { loginWithDevice, loginWithLoopback, FileTokenStore } from "../src/node.js";

const { values } = parseArgs({
  options: {
    issuer: { type: "string", default: "http://localhost:8788" },
    clientId: { type: "string", default: "deyin-desktop" },
    device: { type: "boolean", default: false },
  },
});

async function main() {
  const client = new OAuthClient(
    {
      issuer: values.issuer!,
      clientId: values.clientId!,
      scopes: ["openid", "profile", "email", "offline_access", "model:invoke"],
    },
    new FileTokenStore({ path: join(homedir(), ".deyin", "example-cli.json") }),
  );

  if (await client.isAuthenticated()) {
    const user = await client.getUser();
    console.log(`Already signed in as ${user.name} <${user.email}> (plan: ${user.plan}).`);
    console.log("Delete ~/.deyin/example-cli.json to sign out.");
    return;
  }

  if (values.device) {
    console.log("Starting device login...");
    await loginWithDevice(client, {
      onAuthorization: ({ userCode, verificationUri, verificationUriComplete }) => {
        console.log(`\n  Open: ${verificationUriComplete ?? verificationUri}`);
        console.log(`  Code: ${userCode}\n`);
      },
    });
  } else {
    console.log("Opening your browser to sign in...");
    await loginWithLoopback(client, {
      onAuthUrl: (url) => console.log(`If it doesn't open, visit:\n  ${url}\n`),
    });
  }

  const user = await client.getUser();
  const token = await client.getAccessToken();
  console.log(`\nSigned in as ${user.name} <${user.email}>.`);
  console.log(`Access token (use as Bearer for api.openference.com/v1): ${token.slice(0, 16)}...`);
}

main().catch((err) => {
  console.error("Login failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

import { loginWithDevice, loginWithLoopback } from "@deyin/oauth-client/node";
import type { CliContext } from "../context.js";
import { bold, cyan, dim, errorLine, green } from "../output.js";

export async function loginCommand(ctx: CliContext, opts: { browser?: boolean } = {}): Promise<number> {
  if (await ctx.oauth.isAuthenticated()) {
    try {
      const user = await ctx.oauth.getUser();
      console.log(`Already signed in as ${bold(user.name ?? user.email ?? user.sub)}. Run \`deyin logout\` to switch accounts.`);
      return 0;
    } catch {
      // stale tokens: fall through to a fresh login
    }
  }

  try {
    if (opts.browser) {
      console.log("Opening your browser to sign in...");
      await loginWithLoopback(ctx.oauth, {
        onAuthUrl: (url) => console.log(`If it doesn't open, visit:\n  ${cyan(url)}\n`),
      });
    } else {
      await loginWithDevice(ctx.oauth, {
        onAuthorization: ({ userCode, verificationUri, verificationUriComplete }) => {
          console.log(`\nTo sign in, open ${cyan(verificationUriComplete ?? verificationUri)}`);
          console.log(`and enter the code: ${bold(userCode)}\n`);
          console.log(dim("Waiting for approval..."));
        },
      });
    }
  } catch (err) {
    errorLine(`login failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const user = await ctx.oauth.getUser();
  console.log(`${green("Signed in")} as ${bold(user.name ?? user.sub)}${user.email ? ` <${user.email}>` : ""}${user.plan ? dim(` (plan: ${user.plan})`) : ""}.`);
  return 0;
}

export async function logoutCommand(ctx: CliContext): Promise<number> {
  if (!(await ctx.oauth.isAuthenticated())) {
    console.log("Not signed in.");
    return 0;
  }
  await ctx.oauth.logout();
  console.log("Signed out.");
  return 0;
}

export async function whoamiCommand(ctx: CliContext): Promise<number> {
  if (!(await ctx.oauth.isAuthenticated())) {
    console.log("Not signed in. Run `deyin login`.");
    return 2;
  }
  try {
    const user = await ctx.oauth.getUser();
    console.log(`${bold(user.name ?? user.sub)}${user.email ? ` <${user.email}>` : ""}`);
    if (user.plan) console.log(`plan:   ${user.plan}`);
    console.log(`issuer: ${ctx.config.oauthIssuer}`);
    return 0;
  } catch (err) {
    errorLine(`could not fetch profile: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

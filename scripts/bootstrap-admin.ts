/**
 * Promote one account to admin. Run once per environment:
 *   BOOTSTRAP_ADMIN_EMAIL=someone@example.com npm run bootstrap:admin
 *
 * Deliberately a script, not a migration: a migration that grants admin runs
 * in every environment forever, which is a backdoor with a friendly name.
 * seed.sql is not an option either — it never runs against a linked project.
 */
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
if (!email) throw new Error("Set BOOTSTRAP_ADMIN_EMAIL");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function findUserByEmail(target: string) {
  const perPage = 50;
  for (let page = 1; ; page++) {
    const { data: list, error: listErr } = await db.auth.admin.listUsers({ page, perPage });
    if (listErr) throw listErr;
    const match = list.users.find((u) => u.email?.toLowerCase() === target.toLowerCase());
    if (match) return match;
    if (list.users.length < perPage) return undefined;
  }
}

async function main() {
  let user = await findUserByEmail(email!);

  if (!user) {
    // No password is ever set here — the invite link lets them choose one.
    const { data, error } = await db.auth.admin.inviteUserByEmail(email!, {
      redirectTo: `${process.env.APP_URL ?? "http://localhost:3000"}/login`,
    });
    if (error) throw error;
    user = data.user;
    console.log(`invited ${email}`);
  }

  const { error } = await db
    .from("user_roles")
    .upsert({ user_id: user!.id, role: "admin" }, { onConflict: "user_id" });
  if (error) throw error;

  console.log(`admin: ${email} (${user!.id})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

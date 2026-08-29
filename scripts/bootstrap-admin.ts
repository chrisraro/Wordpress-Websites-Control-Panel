/**
 * Promote one account to admin. Run once per environment:
 *   BOOTSTRAP_ADMIN_EMAIL=someone@example.com npm run bootstrap:admin
 *
 * Deliberately a script, not a migration: a migration that grants admin runs
 * in every environment forever, which is a backdoor with a friendly name.
 * seed.sql is not an option either — it never runs against a linked project.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
if (!email) throw new Error("Set BOOTSTRAP_ADMIN_EMAIL");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data: list, error: listErr } = await db.auth.admin.listUsers();
  if (listErr) throw listErr;
  let user = list.users.find((u) => u.email?.toLowerCase() === email!.toLowerCase());

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

void main();

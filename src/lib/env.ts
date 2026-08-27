const NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_ENCRYPTION_KEY",
  "CRON_SECRET",
] as const;

export type EnvName = (typeof NAMES)[number];

export function getEnv(name: EnvName): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v ? v : undefined;
}

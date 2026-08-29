export type ThemeRefusal = { allowed: false; reason: string };
export type ThemeVerdict = { allowed: true } | ThemeRefusal;

export const ALLOWED: ThemeVerdict = { allowed: true };
export const refuse = (reason: string): ThemeRefusal => ({ allowed: false, reason });

export function getEnv(env = process.env) {
  return {
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || '',
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET || '',
    PUBLIC_URL: env.PUBLIC_URL || '',
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY || ''
  };
}
